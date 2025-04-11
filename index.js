/**
 * index.js
 * This file is the main entrypoint for the application.
 * It sets up an Express server that interfaces with OpenAI's API
 * to create and manage conversation threads with an AI assistant.
 * @author  Giuseppe Careri
 * @see https://www.gcareri.com
 */

// Import required dependencies
const { text } = require("express");
const express = require("express");
const OpenAI = require("openai");
const { getFunctionHandler } = require("./loadFunctions");

require("dotenv").config();

// Initialize Express application
const app = express();
app.use(express.json());

// Check if OpenAI API key is set in environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set in environment variables");
  process.exit(1);
}

// Check if OpenAI assistant ID is set in environment variables
if (!process.env.OPENAI_ASSISTANT_ID) {
  console.error("OPENAI_ASSISTANT_ID is not set in environment variables");
  process.exit(1);
}

// Initialize OpenAI client with API key
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Store thread IDs for each user session
const threadIds = {};

/**
 * Handles incoming prompt requests and streams the response
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handlePromptStream = async (req, res) => {
  const { uuid, message } = req.body;

  // Validate required parameters
  if (!uuid || !message) {
    console.error(`Missing required parameter: ${!uuid ? "Uuid" : "Message"}`);
    return res
      .status(400)
      .json({ message: `${!uuid ? "Uuid" : "Message"} is required` });
  }

  // Set up SSE headers for streaming response
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Create a new thread if one doesn't exist for this user
  if (!threadIds[uuid]) {
    console.log(`Creating new thread for user: ${uuid}`);
    const threadResponse = await openai.beta.threads.create();
    threadIds[uuid] = threadResponse.id;
    console.log(`Thread created with ID: ${threadIds[uuid]}`);
  } else {
    console.log(`Using existing thread: ${threadIds[uuid]}`);
  }

  const runs = await openai.beta.threads.runs.list(threadIds[uuid]);
  const activeRun = runs.data.find((run) =>
    ["in_progress", "queued", "requires_action"].includes(run.status)
  );

  if (activeRun) {
    if (process.env.OPENAI_WAITING_MESSAGE) {
      res.write(
        JSON.stringify({
          type: "text",
          content: process.env.OPENAI_WAITING_MESSAGE,
        })
      );
    }
    res.end();
  } else {
    console.log("Adding message to thread:", message);
    await openai.beta.threads.messages.create(threadIds[uuid], {
      role: "user",
      content: message,
    });

    console.log("Starting assistant response stream");
    const run = await openai.beta.threads.runs
      .stream(threadIds[uuid], {
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
      })
      .on("toolCallDone", async (toolCall) => {
        console.log("Tool call done", toolCall);
        const functionName = toolCall.function.name;
        const functionArgs = toolCall.function.arguments;

        console.log(`>> AI function call: ${functionName}`);
        console.log(`>> AI function call args: ${functionArgs}`);

        try {
          const handler = getFunctionHandler(functionName);
          if (handler) {
            const functionArgs = {
              ...JSON.parse(toolCall.function.arguments),
              uuid,
            };
            const content = await handler(functionArgs);
            console.log(
              `>> Function response: ${functionName} ->`,
              content.data
            );
            res.write(
              JSON.stringify({
                type: "text",
                content: content.data?.message || "",
              })
            );
            await openai.beta.threads.runs.submitToolOutputs(
              threadIds[uuid],
              run.id,
              {
                tool_outputs: [
                  {
                    tool_call_id: toolCall.id,
                    output: JSON.stringify(content.data),
                  },
                ],
              }
            );
          }
        } catch (error) {
          // Handle errors during function execution
          console.error(`Error executing function ${functionName}:`, error);
          res.write(
            JSON.stringify({
              type: "text",
              content: `I encountered an error while processing your request.`,
            })
          );
        }

        res.end();
      })
      .on("textDelta", (textDelta) => {
        res.write(JSON.stringify({ type: "text", content: textDelta.value }));
      })
      .on("textDone", (textDone) => {
        console.log(">> AI response: ", textDone.value);
        res.end();
      });
  }
};

// Define route for prompt streaming
app.post("/prompt-stream", handlePromptStream);

// Start the server
const port = process.env.PORT || 6004;
app.listen(port, () => {
  console.log(`OpenAI Assistant API server listening on port ${port}`);
});
