import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import { logger, ClaudeCodeLogProcessor } from "@langfuse/shared/src/server";
import { z } from "zod/v4";
import { $root } from "@/src/pages/api/public/otel/otlp-proto/generated/root";
import { gunzip } from "node:zlib";
import { ForbiddenError } from "@langfuse/shared";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default withMiddlewares({
  POST: createAuthedProjectAPIRoute({
    name: "OTel Logs (Claude Code)",
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

      let body: Buffer;
      try {
        body = await new Promise((resolve, reject) => {
          let data: any[] = [];
          req.on("data", (chunk) => data.push(chunk));
          req.on("end", () => resolve(Buffer.concat(data)));
          req.on("error", reject);
        });
      } catch (e) {
        logger.error(`Failed to read request body`, e);
        res.status(400);
        return { error: "Failed to read request body" };
      }

      if (req.headers["content-encoding"]?.includes("gzip")) {
        try {
          body = await new Promise((resolve, reject) => {
            gunzip(new Uint8Array(body), (err, result) =>
              err ? reject(err) : resolve(result),
            );
          });
        } catch (e) {
          logger.error(`Failed to decompress request body`, e);
          res.status(400);
          return { error: "Failed to decompress request body" };
        }
      }

      let resourceLogs: any;
      const contentType = req.headers["content-type"]?.toLowerCase();

      // Strict content-type matching does not work if something like `content-type: text/javascript; charset=utf-8` is sent.
      if (
        !contentType ||
        (!contentType.includes("application/json") &&
          !contentType.includes("application/x-protobuf"))
      ) {
        logger.error(`Invalid content type: ${contentType}`);
        res.status(400);
        return { error: "Invalid content type" };
      }

      if (contentType.includes("application/x-protobuf")) {
        try {
          // Try to decode as OTel logs protobuf
          const parsed =
            $root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest.decode(
              body,
            );
          resourceLogs =
            $root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest.toObject(
              parsed,
            ).resourceLogs;
        } catch (e) {
          logger.error(`Failed to parse OTel Protobuf`, e);
          res.status(400);
          return { error: "Failed to parse OTel Protobuf Logs" };
        }
      }

      if (contentType.includes("application/json")) {
        try {
          resourceLogs = JSON.parse(body.toString()).resourceLogs;
        } catch (e) {
          logger.error(`Failed to parse OTel JSON`, e);
          res.status(400);
          return { error: "Failed to parse OTel JSON Logs" };
        }
      }

      if (!resourceLogs || resourceLogs.length === 0) {
        return {};
      }

      const processor = new ClaudeCodeLogProcessor({
        projectId: auth.scope.projectId,
        publicKey: auth.scope.publicKey,
      });

      // Upload the raw OpenTelemetry Log body to S3 and queue for processing
      return processor.publishToOtelIngestionQueue(resourceLogs);
    },
  }),
});
