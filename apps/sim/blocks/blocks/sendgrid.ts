import { Mail } from 'lucide-react'
import type { BlockConfig } from '@/blocks/types'
import type { SendGridSendParams } from '@/tools/sendgrid/send'

export const SendGridBlock: BlockConfig<any> = {
  type: 'sendgrid',
  name: 'SendGrid',
  description: 'Send emails via SendGrid',
  longDescription:
    'Send transactional emails using SendGrid API. Supports HTML content, custom sender names, and basic email fields.',
  docsLink: 'https://docs.sendgrid.com/api-reference/mail-send/mail-send',
  category: 'tools',
  subCategory: 'Communication',
  bgColor: '#1A82E2',
  icon: Mail,
  subBlocks: [
    {
      id: 'apiKey',
      title: 'API Key',
      type: 'short-input',
      layout: 'full',
      placeholder: 'SendGrid API Key (starts with SG...)',
      password: true,
      required: true,
    },
    {
      id: 'from',
      title: 'From Email',
      type: 'short-input',
      layout: 'half',
      placeholder: 'sender@example.com',
      required: true,
    },
    {
      id: 'fromName',
      title: 'From Name',
      type: 'short-input',
      layout: 'half',
      placeholder: 'Sender Name',
    },
    {
      id: 'to',
      title: 'To',
      type: 'short-input',
      layout: 'full',
      placeholder: 'recipient@example.com',
      required: true,
    },
    {
      id: 'subject',
      title: 'Subject',
      type: 'short-input',
      layout: 'full',
      placeholder: 'Email Subject',
      required: true,
    },
    {
      id: 'text',
      title: 'Text Content',
      type: 'long-input',
      layout: 'full',
      placeholder: 'Plain text body...',
      rows: 5,
    },
    {
      id: 'html',
      title: 'HTML Content',
      type: 'code',
      language: 'html',
      layout: 'full',
      placeholder: 'HTML body...',
      mode: 'advanced',
    },
  ],
  tools: {
    access: ['sendgrid_send'],
    config: {
      tool: (params) => 'sendgrid_send',
      params: (params) => params,
    },
  },
  inputs: {
    apiKey: { type: 'string', description: 'SendGrid API Key' },
    from: { type: 'string', description: 'Sender email' },
    fromName: { type: 'string', description: 'Sender name' },
    to: { type: 'string', description: 'Recipient email' },
    subject: { type: 'string', description: 'Email subject' },
    text: { type: 'string', description: 'Plain text content' },
    html: { type: 'string', description: 'HTML content' },
  },
  outputs: {
    message: { type: 'string', description: 'Status message' },
  },
}
