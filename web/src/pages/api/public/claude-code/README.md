# Claude Code Logging Support

This endpoint enables full observability of Claude Code agent workflows by converting OpenTelemetry logs into hierarchical traces in Langfuse.

## Overview

Claude Code natively emits OpenTelemetry logs for various events like user prompts, tool executions, and API requests. This endpoint transforms these flat log events into a structured trace format, allowing you to:

- Track complete agent workflows and conversations
- Monitor tool usage (Read, Write, Edit, Bash, etc.)
- Analyze API request patterns and token consumption
- Debug errors and tool failures
- Understand decision-making processes

## Endpoint

```
POST /api/public/claude-code/logs
```

## Authentication

Use standard Langfuse API authentication:

```bash
Authorization: Bearer <your-langfuse-api-key>
```

## Supported Formats

- **Content-Type**: `application/json` or `application/x-protobuf`
- **Compression**: Gzip compression supported via `Content-Encoding: gzip` header

## Request Body Structure

The endpoint accepts OpenTelemetry Logs formatted as `ExportLogsServiceRequest`:

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [...]
      },
      "scopeLogs": [
        {
          "scope": {
            "name": "claude-code",
            "version": "1.0.0"
          },
          "logRecords": [...]
        }
      ]
    }
  ]
}
```

## Supported Claude Code Events

### 1. User Prompts (`claude_code.user_prompt`)

Captures user messages submitted to Claude Code.

**Attributes:**
- `prompt` - The user's prompt text
- `prompt_length` - Length of the prompt

**Converted to:** Trace root span with user input

### 2. Tool Results (`claude_code.tool_result`)

Captures tool execution results.

**Attributes:**
- `tool_name` - Name of the tool (Read, Write, Edit, Bash, etc.)
- `duration_ms` - Execution time in milliseconds
- `success` - "true" or "false"
- `error` - Error message if failed
- `decision` - User's decision ("accept" or "reject")
- `source` - Decision source ("config", "user_permanent", etc.)
- `tool_parameters` - JSON string with tool-specific parameters

**Special attributes for Bash tool:**
- `bash_command`
- `full_command`
- `timeout`
- `description`
- `sandbox`

**Converted to:** Span or Agent observation based on tool type

### 3. API Requests (`claude_code.api_request`)

Captures Claude API requests with token usage.

**Attributes:**
- `model` - Model name (e.g., "claude-sonnet-4-5-20250929")
- `input_tokens` - Number of input tokens
- `output_tokens` - Number of output tokens
- `cache_creation_tokens` - Cache creation tokens
- `cache_read_tokens` - Cache read tokens
- `total_tokens` - Total token count
- `duration_ms` - Request duration
- `cost` - Request cost (if available)

**Converted to:** Generation observation with usage details

### 4. API Errors (`claude_code.api_error`)

Captures failed API requests.

**Attributes:**
- `error` - Error message
- `status_code` - HTTP status code

**Converted to:** Generation observation with error status

### 5. Tool Decisions (`claude_code.tool_decision`)

Captures tool permission decisions.

**Attributes:**
- `tool_name` - Tool that requires decision
- `decision` - "accept" or "reject"
- `source` - Decision source

**Converted to:** Event observation

## Configuration

### Claude Code Setup

Enable OpenTelemetry logging in Claude Code:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=<langfuse-endpoint>/api/public/claude-code/logs
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <langfuse-api-key>"
```

Optional privacy controls:

```bash
# Enable logging of full prompt content (default: disabled)
export OTEL_LOG_USER_PROMPTS=1

# Set log export interval (default: 5 seconds)
export OTEL_LOGS_EXPORT_INTERVAL=5000
```

## Example Usage

### cURL Example

```bash
curl -X POST https://your-langfuse-instance.com/api/public/claude-code/logs \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "resourceLogs": [{
      "resource": {
        "attributes": [{
          "key": "service.name",
          "value": {"stringValue": "claude-code"}
        }]
      },
      "scopeLogs": [{
        "scope": {
          "name": "claude-code",
          "version": "1.0.0"
        },
        "logRecords": [{
          "timeUnixNano": 1234567890000000000,
          "body": {"stringValue": "User prompt"},
          "attributes": [{
            "key": "prompt",
            "value": {"stringValue": "Help me debug this code"}
          }],
          "eventName": "claude_code.user_prompt"
        }]
      }]
    }]
  }'
```

## Trace Structure

The converter creates hierarchical traces with the following structure:

```
Trace (Session/Conversation)
├── User Prompt (root span)
├── Tool: Read (span)
├── Tool: Write (span)
├── Claude API Request (generation)
│   ├── Input tokens
│   ├── Output tokens
│   └── Cost details
├── Tool: Bash (span)
└── Tool Decision (event)
```

## Observation Types

The converter maps Claude Code events to Langfuse observation types:

| Claude Code Event | Langfuse Type | Description |
|-------------------|---------------|-------------|
| user_prompt | SPAN | User input to the agent |
| tool_result (most tools) | SPAN | Tool execution |
| tool_result (Task tool) | AGENT | Sub-agent execution |
| api_request | GENERATION | LLM API call with token usage |
| api_error | GENERATION | Failed LLM API call |
| tool_decision | EVENT | Permission decision |

## Benefits

1. **Complete Visibility**: See every step of Claude Code's workflow
2. **Performance Monitoring**: Track tool execution times and API latencies
3. **Cost Tracking**: Monitor token usage and costs per session
4. **Error Debugging**: Identify failures and their causes
5. **Usage Analytics**: Understand which tools and models are used most
6. **Conversation Analysis**: Replay entire agent workflows

## Response

### Success Response

```json
{
  "id": "job-id",
  "timestamp": "2025-01-13T10:30:00.000Z"
}
```

The logs are processed asynchronously. Traces will appear in Langfuse within a few seconds.

### Error Responses

```json
{
  "error": "Failed to parse OTel JSON Logs"
}
```

Common error cases:
- Invalid content type (400)
- Malformed JSON/Protobuf (400)
- Missing authentication (401)
- Ingestion suspended (403)
- Internal conversion error (500)

## Implementation Details

The conversion process:

1. **Parse Logs**: Accept and decompress OTel logs (JSON or Protobuf)
2. **Group by Session**: Group log events by trace ID or session ID
3. **Convert to Spans**: Transform each log event into an appropriate span type
4. **Build Hierarchy**: Establish parent-child relationships between spans
5. **Extract Metadata**: Pull out token usage, costs, timings, errors
6. **Process as Traces**: Feed converted traces through existing OTel trace pipeline

## Privacy and Security

- Prompt content logging is disabled by default
- Enable with `OTEL_LOG_USER_PROMPTS=1` for full observability
- API keys and file contents are never logged
- All data respects Langfuse's existing security and privacy controls

## Limitations

- Parent-child relationships are inferred from timestamps (future: explicit parent span IDs)
- Very large log batches may experience processing delays
- Session/conversation grouping requires consistent trace IDs

## Support

For issues or questions:
- Check logs for detailed error messages
- Verify Claude Code telemetry configuration
- Ensure API key has proper permissions
- Review Langfuse ingestion limits and quotas
