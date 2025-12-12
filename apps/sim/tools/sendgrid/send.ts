import type { ToolConfig } from '@/tools/types'

export interface SendGridSendParams {
  apiKey: string
  to: string
  from: string
  fromName?: string
  subject: string
  text?: string
  html?: string
}

export const sendGridSendTool: ToolConfig<SendGridSendParams> = {
  id: 'sendgrid_send',
  name: 'SendGrid Send',
  description: 'Send emails using SendGrid API',
  version: '1.0.0',

  params: {
    apiKey: {
      type: 'string',
      required: true,
      visibility: 'hidden', // Usually injected via env or user config
      description: 'SendGrid API Key',
    },
    to: {
      type: 'string',
      required: true,
      description: 'Recipient email address',
    },
    from: {
      type: 'string',
      required: true,
      description: 'Sender email address',
    },
    fromName: {
      type: 'string',
      required: false,
      description: 'Sender name',
    },
    subject: {
      type: 'string',
      required: true,
      description: 'Email subject',
    },
    text: {
      type: 'string',
      required: false,
      description: 'Plain text content',
    },
    html: {
      type: 'string',
      required: false,
      description: 'HTML content',
    },
  },

  request: {
    url: 'https://api.sendgrid.com/v3/mail/send',
    method: 'POST',
    headers: (params) => ({
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    }),
    body: (params) => {
      // SendGrid requires 'from' to be an object
      const fromObj = params.fromName
        ? { email: params.from, name: params.fromName }
        : { email: params.from };

      return {
        personalizations: [
          {
            to: [{ email: params.to }],
          },
        ],
        from: fromObj,
        subject: params.subject,
        content: [
          ...(params.text ? [{ type: 'text/plain', value: params.text }] : []),
          ...(params.html ? [{ type: 'text/html', value: params.html }] : []),
        ],
      }
    },
  },

  transformResponse: async (response) => {
    // SendGrid returns 202 Accepted on success with empty body usually
    if (response.status === 202 || response.status === 200) {
        return {
            success: true,
            output: { message: 'Email queued for delivery' }
        }
    }

    // If we get here, it's likely an error that wasn't caught by isErrorResponse
    // but usually non-2xx throws error in executeTool.
    // If it's a JSON response:
    let data;
    try {
        data = await response.json();
    } catch (e) {
        data = await response.text();
    }

    return {
        success: true,
        output: data
    }
  },

  outputs: {
      message: { type: 'string', description: 'Status message' }
  }
}
