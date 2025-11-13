import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import {
  logger,
  OtelIngestionProcessor,
  ClaudeCodeLogsToTracesConverter,
} from "@langfuse/shared/src/server";
import { z } from "zod/v4";
import { $root } from "@/src/pages/api/public/otel/otlp-proto/generated/root";
import { gunzip } from "node:zlib";
import { ForbiddenError } from "@langfuse/shared";

export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Claude Code OpenTelemetry Logs Ingestion Endpoint
 *
 * This endpoint accepts OpenTelemetry logs from Claude Code and converts them
 * into OpenTelemetry traces for analysis in Langfuse.
 *
 * Claude Code emits structured log events for:
 * - User prompts (claude_code.user_prompt)
 * - Tool executions (claude_code.tool_result)
 * - API requests (claude_code.api_request)
 * - API errors (claude_code.api_error)
 * - Tool decisions (claude_code.tool_decision)
 *
 * These logs are transformed into hierarchical traces with proper parent-child
 * relationships, allowing full observability of Claude Code agent workflows.
 *
 * Supported formats:
 * - application/x-protobuf (OpenTelemetry Protobuf)
 * - application/json (OpenTelemetry JSON)
 * - Gzip compression supported
 */
export default withMiddlewares({
  POST: createAuthedProjectAPIRoute({
    name: "Claude Code Logs to Traces",
    querySchema: z.any(),
    responseSchema: z.any(),
    rateLimitResource: "ingestion",
    fn: async ({ req, res, auth }) => {
      // Check if ingestion is suspended due to usage threshold
      if (auth.scope.isIngestionSuspended) {
        throw new ForbiddenError(
          "Ingestion suspended: Usage threshold exceeded. Please upgrade your plan.",
        );
      }

      // Read raw request body
      let body: Buffer;
      try {
        body = await new Promise((resolve, reject) => {
          let data: any[] = [];
          req.on("data", (chunk) => data.push(chunk));
          req.on("end", () => resolve(Buffer.concat(data)));
          req.on("error", reject);
        });
      } catch (e) {
        logger.error(`Failed to read request body for Claude Code logs`, e);
        res.status(400);
        return { error: "Failed to read request body" };
      }

      // Decompress if gzipped
      if (req.headers["content-encoding"]?.includes("gzip")) {
        try {
          body = await new Promise((resolve, reject) => {
            gunzip(new Uint8Array(body), (err, result) =>
              err ? reject(err) : resolve(result),
            );
          });
        } catch (e) {
          logger.error(`Failed to decompress Claude Code logs request body`, e);
          res.status(400);
          return { error: "Failed to decompress request body" };
        }
      }

      // Parse logs based on content type
      let resourceLogs: any;
      const contentType = req.headers["content-type"]?.toLowerCase();

      if (
        !contentType ||
        (!contentType.includes("application/json") &&
          !contentType.includes("application/x-protobuf"))
      ) {
        logger.error(
          `Invalid content type for Claude Code logs: ${contentType}`,
        );
        res.status(400);
        return {
          error:
            "Invalid content type. Expected application/json or application/x-protobuf",
        };
      }

      // Parse protobuf format
      if (contentType.includes("application/x-protobuf")) {
        try {
          const parsed =
            $root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest.decode(
              body,
            );
          resourceLogs =
            $root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest.toObject(
              parsed,
            ).resourceLogs;
        } catch (e) {
          logger.error(`Failed to parse Claude Code OTel Protobuf logs`, e);
          res.status(400);
          return { error: "Failed to parse OTel Protobuf Logs" };
        }
      }

      // Parse JSON format
      if (contentType.includes("application/json")) {
        try {
          const parsed = JSON.parse(body.toString());
          resourceLogs = parsed.resourceLogs;
        } catch (e) {
          logger.error(`Failed to parse Claude Code OTel JSON logs`, e);
          res.status(400);
          return { error: "Failed to parse OTel JSON Logs" };
        }
      }

      if (!resourceLogs || resourceLogs.length === 0) {
        logger.info("No resource logs found in Claude Code request");
        return { message: "No logs to process" };
      }

      logger.info(
        `Processing ${resourceLogs.length} resource logs from Claude Code`,
      );

      try {
        // Convert logs to traces
        const converter = new ClaudeCodeLogsToTracesConverter();
        const resourceSpans = converter.convert(resourceLogs);

        if (!resourceSpans || resourceSpans.length === 0) {
          logger.info("No spans generated from Claude Code logs");
          return { message: "No spans generated from logs" };
        }

        logger.info(
          `Converted Claude Code logs to ${resourceSpans.length} resource spans`,
        );

        // Process converted traces through existing OTel ingestion pipeline
        const processor = new OtelIngestionProcessor({
          projectId: auth.scope.projectId,
          publicKey: auth.scope.publicKey,
        });

        // Upload to S3 and queue for processing
        const result =
          await processor.publishToOtelIngestionQueue(resourceSpans);

        logger.info("Successfully queued Claude Code traces for processing", {
          projectId: auth.scope.projectId,
          resourceSpanCount: resourceSpans.length,
        });

        return result;
      } catch (e) {
        logger.error("Error converting Claude Code logs to traces", e);
        res.status(500);
        return { error: "Failed to convert logs to traces" };
      }
    },
  }),
});
