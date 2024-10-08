/**
 * index.js
 * This file is the main entrypoint for the application.
 * @author  Giuseppe Careri
 * @see https://www.gcareri.com
 */
const express = require('express');
const OpenAI = require('openai');

require('dotenv').config();

const app = express();

app.use(express.json());


/**
 * Handles a prompt stream from the client and uses the OpenAI API to generate
 * a response stream. The response stream is sent back to the client as a
 * series of Server-Sent Events.
 *
 * @param {Object} req - The Express request object
 * @param {Object} res - The Express response object
 */
const handlePromptStream = async (req, res) => {
    const { messages } = req.body;

    if (!messages) {
        return res.status(400).json({ message: 'Messages is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const threadResponse = await openai.beta.threads.create({ messages });
        const threadId = threadResponse.id;

        const stream = await openai.beta.threads.runs.create(threadId, {
            assistant_id: process.env.OPENAI_ASSISTANT_ID,
            stream: true
        });

        let isWriting = false;
        for await (const chunk of stream) {
            console.log(chunk.event)
            switch (chunk.event) {
                case 'thread.run.created':
                    if (process.env.OPENAI_WAITING_MESSAGE) {
                        setTimeout(() => {
                            if (!isWriting) res.write(process.env.OPENAI_WAITING_MESSAGE)
                        }, +process.env.OPENAI_WAITING_TIMEOUT || 2000);
                    }
                    break;
                case 'thread.message.delta':
                    isWriting = true;
                    const content = chunk.data.delta.content[0];
                    if (content.type == 'text') {
                        res.write(content.text.value);
                    }
                    break;
                case 'thread.message.completed':
                    res.end();
                    break;
                default:
                    break;
            }
        }
    } catch (error) {
        console.error('Error calling OpenAI API:', error.message);
        res.status(500).json({ message: 'Error communicating with OpenAI' });
    }
}

app.post('/prompt-stream', handlePromptStream);

const port = process.env.PORT || 6004;
app.listen(port, () => {
    console.log(`OpenAI listening on port ${port}`);
});
