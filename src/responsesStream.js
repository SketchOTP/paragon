import {
  buildResponseObject,
  makeChatCompletionChunk,
  responsesUsageToChatUsage
} from "./responsesFormat.js";

export function streamResponsesSse({ res, config, model, onGenerate }) {
  const responseId = `resp_${Date.now()}`;
  const messageId = `msg_${Date.now()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (eventType, payload) => {
    sequence += 1;
    const data = { ...payload, type: eventType, sequence_number: sequence };
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const baseResponse = () => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model,
    output: [],
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: []
  });

  sendEvent("response.created", { response: baseResponse() });
  sendEvent("response.in_progress", { response: baseResponse() });
  sendEvent("response.output_item.added", {
    output_index: 0,
    item: {
      id: messageId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: []
    }
  });
  sendEvent("response.content_part.added", {
    output_index: 0,
    content_index: 0,
    item_id: messageId,
    part: { type: "output_text", text: "" }
  });

  let fullText = "";

  const onChunk = (chunk) => {
    fullText += chunk;
    sendEvent("response.output_text.delta", {
      output_index: 0,
      content_index: 0,
      item_id: messageId,
      delta: chunk
    });
  };

  return onGenerate(onChunk)
    .then(({ provider, routedProvider, durationMs }) => {
      sendEvent("response.output_text.done", {
        output_index: 0,
        content_index: 0,
        item_id: messageId,
        text: fullText
      });
      sendEvent("response.content_part.done", {
        output_index: 0,
        content_index: 0,
        item_id: messageId,
        part: { type: "output_text", text: fullText }
      });
      sendEvent("response.output_item.done", {
        output_index: 0,
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: fullText }]
        }
      });

      const completed = buildResponseObject({
        model,
        content: fullText,
        provider,
        routedProvider,
        durationMs
      });
      completed.id = responseId;
      completed.created_at = createdAt;
      completed.output[0].id = messageId;

      sendEvent("response.completed", { response: completed });
      res.write("data: [DONE]\n\n");
      res.end();
    })
    .catch((error) => {
      sendEvent("error", { message: error.message });
      res.end();
    });
}

export function streamChatFromResponsesInput({ res, config, model, onGenerate }) {
  const chunkId = `chatcmpl-${Date.now()}`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let roleSent = false;

  const onChunk = (chunk) => {
    const delta = { content: chunk };
    if (!roleSent) {
      delta.role = "assistant";
      roleSent = true;
    }
    send(makeChatCompletionChunk({ chunkId, model, delta }));
  };

  return onGenerate(onChunk)
    .then(({ provider, routedProvider, durationMs }) => {
      send(
        makeChatCompletionChunk({
          chunkId,
          model,
          delta: {},
          finishReason: "stop"
        })
      );
      const usageResponse = buildResponseObject({
        model,
        content: "",
        provider,
        routedProvider,
        durationMs
      });
      send(
        makeChatCompletionChunk({
          chunkId,
          model,
          delta: {},
          usage: responsesUsageToChatUsage(usageResponse)
        })
      );
      res.write("data: [DONE]\n\n");
      res.end();
    })
    .catch((error) => {
      if (!roleSent) {
        send(
          makeChatCompletionChunk({
            chunkId,
            model,
            delta: { role: "assistant", content: error.message }
          })
        );
      }
      send(makeChatCompletionChunk({ chunkId, model, delta: {}, finishReason: "stop" }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
}
