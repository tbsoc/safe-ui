// Cloudflare Pages Function: /api/safe-queue/* -> Safe Queue Service, with the API key added server-side.
// Set SAFE_API_KEY (and optionally ALLOWED_SAFES) under the Pages project's Settings > Variables and Secrets.
import { handleQueueRequest, type QueueProxyEnv } from '../../../src/server/queueProxy'

interface Context {
  request: Request
  env: QueueProxyEnv
  params: { path?: string | string[] }
}

export const onRequest = (context: Context): Promise<Response> => {
  const p = context.params.path
  const path = Array.isArray(p) ? p.join('/') : (p ?? '')
  return handleQueueRequest(context.request, context.env, path)
}
