/**
 * index.js
 * This file is the main entrypoint for the application.
 * @author  Giuseppe Careri
 * @see https://www.gcareri.com
 */

const express = require('express');
const OpenAI = require('openai');
const { resolve } = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set in environment variables');
    process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const threadIds = {};
const activeRuns = {};

const MAX_RETRIES = process.env.MAX_RETRIES || 10;
const RETRY_DELAY = process.env.RETRY_DELAY || 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForActiveRun = async (threadId, maxRetries = MAX_RETRIES, delay = RETRY_DELAY) => {
    if (!activeRuns[threadId]) {
        return true;
    }

    // Check if the run is actually still active on OpenAI's side
    try {
        const runs = await openai.beta.threads.runs.list(threadId);
        const activeRun = runs.data.find(run => 
            ['in_progress', 'queued', 'requires_action'].includes(run.status)
        );
        
        if (!activeRun) {
            console.log(`No active run found on OpenAI for thread: ${threadId}`);
            activeRuns[threadId] = false;
            return true;
        }
        
        console.log(`Found active run ${activeRun.id} with status ${activeRun.status}`);
    } catch (error) {
        console.error('Error checking run status:', error);
        // If we can't check, we'll fall back to the retry logic
    }

    for (let retries = 0; retries < maxRetries; retries++) {
        if (!activeRuns[threadId]) {
            console.log(`Run is no longer active: ${threadId}`);
            return true;
        }
        console.log(`Run is still active: ${threadId}. Retry: ${retries + 1}/${maxRetries}, Delay: ${delay / 1000} seconds`);
        await sleep(delay);
    }

    // If we reach here, we've exceeded retries
    console.log(`Timeout or retries exceeded: ${threadId}`);
    
    try {
        // Try to cancel any active run
        const runs = await openai.beta.threads.runs.list(threadId);
        const activeRun = runs.data.find(run => 
            ['in_progress', 'queued', 'requires_action'].includes(run.status)
        );
        
        if (activeRun) {
            console.log(`Attempting to cancel run ${activeRun.id}`);
            await openai.beta.threads.runs.cancel(threadId, activeRun.id);
        }
    } catch (error) {
        console.error('Error cancelling active run:', error);
    }
    
    activeRuns[threadId] = false;
    return false;
};

const handleFunctionCall = async (uuid, tool_call, chunk, res) => {
    const function_name = tool_call.function.name;
    let function_args;
    
    try {
        function_args = JSON.parse(tool_call.function.arguments);
    } catch (error) {
        console.error('Failed to parse function arguments:', error);
        return handleFunctionError(chunk, tool_call, 'Invalid function arguments', res);
    }
    
    function_args.uuid = uuid;
    console.log('Function:', function_name, 'Args:', function_args);

    let result = null;
    try {
        const { default: avrFunction } = await import(resolve(__dirname, 'avr_functions', `${function_name}.js`));
        result = await avrFunction(function_args);
    } catch (error) {
        console.log('AVR function not found or failed:', error.message);
    }

    if (!result) {
        try {
            const { default: externalFunction } = await import(resolve(__dirname, 'functions', `${function_name}.js`));
            result = await externalFunction(function_args);
        } catch (error) {
            console.log('External function not found or failed:', error.message);
            return handleFunctionError(chunk, tool_call, 'Function execution failed', res);
        }
    }

    const run = await openai.beta.threads.runs.submitToolOutputs(
        chunk.data.thread_id,
        chunk.data.id,
        {
            tool_outputs: [
                {
                    tool_call_id: tool_call.id,
                    output: JSON.stringify(result ? result.data : { status: 'failure', message: 'Function execution failed' }),
                },
            ],
            stream: true,
        }
    );
    handleStream(uuid, run, res);
};

const handleFunctionError = async (chunk, tool_call, errorMessage, res) => {
    try {
        const run = await openai.beta.threads.runs.submitToolOutputs(
            chunk.data.thread_id,
            chunk.data.id,
            {
                tool_outputs: [
                    {
                        tool_call_id: tool_call.id,
                        output: JSON.stringify({ status: 'failure', message: errorMessage }),
                    },
                ],
                stream: true,
            }
        );
        handleStream(uuid, run, res);
    } catch (error) {
        console.error('Failed to submit error output:', error);
        res.status(500).end();
    }
};

const handleStream = async (uuid, stream, res) => {
    let isWriting = false;
    let waitingMessageTimeout;

    try {
        for await (const chunk of stream) {
            // Log event with timestamp for better debugging
            console.log(`[${new Date().toISOString()}] Event: ${chunk.event}`);

            try {
                switch (chunk.event) {
                    case 'thread.run.created':
                        if (process.env.OPENAI_WAITING_MESSAGE) {
                            waitingMessageTimeout = setTimeout(() => {
                                if (!isWriting) {
                                    sendStreamResponse(res, {
                                        type: 'status',
                                        content: process.env.OPENAI_WAITING_MESSAGE
                                    });
                                }
                            }, +process.env.OPENAI_WAITING_TIMEOUT || 2000);
                        }
                        break;

                    case 'thread.message.delta':
                        isWriting = true;
                        clearTimeout(waitingMessageTimeout);
                        const content = chunk.data.delta.content[0];
                        if (content?.type === 'text') {
                            sendStreamResponse(res, {
                                type: 'text',
                                content: content.text.value
                            });
                        }
                        break;

                    case 'thread.run.requires_action':
                        clearTimeout(waitingMessageTimeout);
                        if (chunk.data.required_action.type === 'submit_tool_outputs') {
                            await handleToolOutputs(uuid, chunk, res);
                        } else {
                            console.warn('Unhandled requires_action type:', chunk.data.required_action.type);
                            sendStreamResponse(res, {
                                type: 'error',
                                content: 'Unsupported action type'
                            });
                        }
                        break;

                    case 'thread.run.completed':
                        clearTimeout(waitingMessageTimeout);
                        sendStreamResponse(res, {
                            type: 'status',
                            content: 'completed'
                        });
                        res.end();
                        break;

                    case 'thread.run.failed':
                        clearTimeout(waitingMessageTimeout);
                        console.error('Run failed:', chunk.data.error);
                        sendStreamResponse(res, {
                            type: 'error',
                            content: 'Assistant run failed'
                        });
                        res.end();
                        break;

                    default:
                        console.log('Unhandled event type:', chunk.event);
                        break;
                }
            } catch (error) {
                console.error(`Error handling event ${chunk.event}:`, error);
                sendStreamResponse(res, {
                    type: 'error',
                    content: 'Error processing response'
                });
            }
        }
    } catch (error) {
        console.error('Stream error:', error);
        sendStreamResponse(res, {
            type: 'error',
            content: 'Stream connection error'
        });
        res.end();
    } finally {
        clearTimeout(waitingMessageTimeout);
        if (threadIds[uuid]) {
            activeRuns[threadIds[uuid]] = false;
        }
    }
};

const handleToolOutputs = async (uuid, chunk, res) => {
    const toolCalls = chunk.data.required_action.submit_tool_outputs.tool_calls;
    for (const tool_call of toolCalls) {
        if (tool_call.type === 'function') {
            try {
                await handleFunctionCall(uuid, tool_call, chunk, res);
            } catch (error) {
                console.error('Error handling function call:', error);
                await handleFunctionError(chunk, tool_call, error.message, res);
            }
        }
    }
};

const sendStreamResponse = (res, data) => {
    if (!res.writableEnded) {
        try {
            res.write(JSON.stringify(data));
        } catch (error) {
            console.error('Error writing to stream:', error);
        }
    }
};

const handlePromptStream = async (req, res) => {
    const { uuid, message } = req.body;

    if (!uuid || !message) {
        return res.status(400).json({ message: `${!uuid ? 'Uuid' : 'Message'} is required` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        if (!threadIds[uuid]) {
            const threadResponse = await openai.beta.threads.create();
            threadIds[uuid] = threadResponse.id;
            console.log('Created thread:', threadIds[uuid], 'for uuid:', uuid);
        }

        const threadId = threadIds[uuid];
        
        // Check for active run and wait/cancel if necessary
        const runFinished = await waitForActiveRun(threadId);
        if (!runFinished) {
            return res.status(429).json({ 
                message: 'A run is already active and could not be cancelled. Please try again later.',
                threadId: threadId
            });
        }

        // Set active flag before creating the message
        activeRuns[threadId] = true;

        try {
            await openai.beta.threads.messages.create(threadId, {
                role: "user",
                content: message,
            });
        } catch (error) {
            activeRuns[threadId] = false;
            if (error.status === 400 && error.message.includes("while a run")) {
                return res.status(429).json({ 
                    message: 'Another request is in progress. Please try again in a few seconds.',
                    threadId: threadId
                });
            }
            throw error;
        }

        const stream = await openai.beta.threads.runs.create(threadId, {
            assistant_id: process.env.OPENAI_ASSISTANT_ID,
            stream: true
        });

        handleStream(uuid, stream, res);
    } catch (error) {
        console.error('Error calling OpenAI API:', error.message);
        if (threadIds[uuid]) {
            activeRuns[threadIds[uuid]] = false;
        }
        res.status(error.status || 500).json({ 
            message: 'Error communicating with OpenAI',
            error: error.message
        });
    }
};

app.post('/prompt-stream', handlePromptStream);

const port = process.env.PORT || 6004;
app.listen(port, () => {
    console.log(`OpenAI listening on port ${port}`);
});