/**
 * index.js
 * This file is the main entrypoint for the application.
 * @author  Giuseppe Careri
 * @see https://www.gcareri.com
 */
const express = require('express');
const OpenAI = require('openai');
const { resolve } = require('path');
const threadIds = {};
const activeRuns = {};

require('dotenv').config();

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForActiveRun = async (threadId, maxRetries = 10, delay = 1000) => {
    let retries = 0;

    while (retries < maxRetries) {
        if (!activeRuns[threadId]) {
            console.log(`Run is no longer active: ${threadId}`);
            return true; // Run is no longer active
        }

        console.log(`Run is still active: ${threadId}. Retry: ${retries}, Delay: ${delay / 1000} seconds`);
        retries++;
        await sleep(delay);
    }

    console.log(`Timeout or retries exceeded: ${threadId}`);
    return false; // Timeout or retries exceeded
}

/**
 * Handles the stream of events from OpenAI API and sends appropriate responses to the client.
 * @param {AsyncIterable} stream - The stream of events from OpenAI API
 * @param {Object} res - The Express response object
 */
const handleStream = async (uuid, stream, res) => {
    let isWriting = false;
    for await (const chunk of stream) {
        console.log(chunk.event);
        switch (chunk.event) {
            case 'thread.run.created':
                if (process.env.OPENAI_WAITING_MESSAGE) {
                    setTimeout(() => {
                        if (!isWriting) res.write(JSON.stringify({ type: 'text', content: process.env.OPENAI_WAITING_MESSAGE }));
                    }, +process.env.OPENAI_WAITING_TIMEOUT || 2000);
                }
                break;
            case 'thread.message.delta':
                isWriting = true;
                const content = chunk.data.delta.content[0];
                if (content.type === 'text') {
                    res.write(JSON.stringify({ type: 'text', content: content.text.value }));
                }
                break;
            case 'thread.run.requires_action':
                switch (chunk.data.required_action.type) {
                    case 'submit_tool_outputs':
                        for (const tool_call of chunk.data.required_action.submit_tool_outputs.tool_calls) {
                            if (tool_call.type === 'function') {
                                try {
                                    const function_name = tool_call.function.name;
                                    const function_args = JSON.parse(tool_call.function.arguments);
                                    function_args.uuid = uuid;
                                    console.log('Function:', function_name, 'Args:', function_args);

                                    let result = null;
                                    try {
                                        const { default: avrFunction } = await import(resolve(__dirname, 'avr_functions', `${function_name}.js`));
                                        result = await avrFunction(function_args);
                                    } catch (error) {
                                        console.log('AVR function not found:', function_name);
                                    }

                                    try {
                                        const { default: externalFunction } = await import(resolve(__dirname, 'functions', `${function_name}.js`));
                                        result = await externalFunction(function_args);
                                    } catch (error) {
                                        console.log('External function not found:', function_name);
                                    }

                                    if (!result) {
                                        const run = await openai.beta.threads.runs.submitToolOutputs(
                                            chunk.data.thread_id,
                                            chunk.data.id,
                                            {
                                                tool_outputs: [
                                                    {
                                                        tool_call_id: tool_call.id,
                                                        output: JSON.stringify(result ? result.data : { error: true, message: 'Function not found' })
                                                    },
                                                ],
                                                stream: true,
                                            }
                                        );
                                        await handleStream(uuid, run, res);
                                    } else {
                                        res.write(JSON.stringify({ type: 'text', content: 'Function not found' }));
                                    }
                                    break;
                                } catch (error) {
                                    console.error('Error calling function:', error.message);
                                    res.write(JSON.stringify({ type: 'text', content: 'Error calling function' }));
                                    break;
                                }
                            }
                        }
                        break;
                    default:
                        console.log('Unhandled requires_action type:', chunk.data.required_action.type);
                        break;
                }
                break;
            case 'thread.run.completed':
                res.end();
                break;
            default:
                break;
        }
    }
    activeRuns[threadIds[uuid]] = false;
}

/**
 * Handles a prompt stream from the client and uses the OpenAI API to generate
 * a response stream. The response stream is sent back to the client as a
 * series of Server-Sent Events.
 *
 * @param {Object} req - The Express request object
 * @param {Object} res - The Express response object
 */
const handlePromptStream = async (req, res) => {
    const { uuid, message } = req.body;

    if (!uuid) {
        return res.status(400).json({ message: 'Uuid is required' });
    }

    if (!message) {
        return res.status(400).json({ message: 'Message is required' });
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


        const runFinished = await waitForActiveRun(threadIds[uuid]);
        if (!runFinished) {
            console.warn('Run did not complete within the allowed time.');
            res.status(400).json({ message: 'A run is already active. Please try again later.' });
            return;
        }

        activeRuns[threadIds[uuid]] = true;

        // Add user message to the thread
        await openai.beta.threads.messages.create(threadIds[uuid], {
            role: "user",
            content: message,
        });

        let stream = await openai.beta.threads.runs.create(threadIds[uuid], {
            assistant_id: process.env.OPENAI_ASSISTANT_ID,
            stream: true
        });

        await handleStream(uuid, stream, res);
    } catch (error) {
        console.error('Error calling OpenAI API:', error.message);

        if (threadIds[uuid]) {
            activeRuns[threadIds[uuid]] = false;
        }

        res.status(500).json({ message: 'Error communicating with OpenAI' });
    }
}

app.post('/prompt-stream', handlePromptStream);

const port = process.env.PORT || 6004;
app.listen(port, () => {
    console.log(`OpenAI listening on port ${port}`);
});
