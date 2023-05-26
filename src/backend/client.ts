import * as line from '@line/bot-sdk'
import * as sdk from 'botpress/sdk'
import _ from 'lodash'

import { Config } from '../config'

import { MountedBot } from './typings'

const debug = DEBUG('channel-line')
const debugIncoming = debug.sub('incoming')
const debugOutgoing = debug.sub('outgoing')

export const MIDDLEWARE_NAME = 'line.sendMessage'

const outgoingTypes = ['typing', 'text', 'single-choice', 'image', 'carousel', 'card']

export class LineClient {
  private logger: sdk.Logger
  private lineClient: line.Client
  private webhookUrl: string
  private kvs: sdk.KvsService

  constructor(
    private bp: typeof sdk,
    private botId: string,
    private config: Config,
    private router: sdk.http.RouterExtension,
    private route: string
  ) {
    this.logger = bp.logger.forBot(botId)
  }

  async initialize() {
    if (!this.config.channelAccessToken || !this.config.channelSecret) {
      return this.logger.error(
        `[${this.botId}] channelAccessToken, channelSecret must be configured to use this channel.`
      )
    }

    const url = (await this.router.getPublicPath()) + this.route
    this.webhookUrl = url.replace('BOT_ID', this.botId)

    this.lineClient = new line.Client(this.config)
    this.kvs = this.bp.kvs.forBot(this.botId)

    this.logger.info(`Line webhook listening at ${this.webhookUrl}`)
  }

  auth(req): boolean {
    const signature = req.headers['x-line-signature']
    return line.validateSignature(JSON.stringify(req.body), this.config.channelSecret, signature)
  }

  getKvsKey(target: string, threadId: string) {
    return `${target}_${threadId}`
  }

  async handleWebhookRequest(body: any, bot: MountedBot) {
    debugIncoming('Received message', body)

    for (const event of body.events) {
      if (event.type === 'message') {
        const message: line.EventMessage = event.message
        if (message.type === 'text') {
          await this.sendIncomingEvent(bot.botId, 'text', message, event.source.userId)
        } else {
          // TODO: implement handlers for other types of message
        }
      } else if (event.type === 'postback') {
        const postback: line.Postback = event.postback
        const payload = JSON.parse(postback.data)
        await this.sendIncomingEvent(bot.botId, 'text', payload, event.source.userId)
      } else {
        // TODO: implement handlers for other types of event
      }
    }
  }

  async sendIncomingEvent(botId, type, payload, target) {
    await this.bp.events.sendEvent(
      this.bp.IO.Event({
        botId,
        channel: 'line',
        direction: 'incoming',
        type,
        payload,
        target
      })
    )
  }

  async handleOutgoingEvent(event: sdk.IO.Event, next: sdk.IO.MiddlewareNextCallback) {
    const messageType = event.type === 'default' ? 'text' : event.type
    if (!_.includes(outgoingTypes, messageType)) {
      return next(new Error('Unsupported event type: ' + event.type))
    }
    if (messageType === 'typing') {
      // nothing to do
    } else if (messageType === 'text') {
      await this.sendTextMessage(event)
    } else if (messageType === 'single-choice') {
      await this.sendSingleChoiceMessage(event)
    } else if (messageType === 'image') {
      await this.sendImageMessage(event)
    } else if (messageType === 'carousel') {
      await this.sendCarouselMessage(event)
    } else if (messageType === 'card') {
      await this.sendCardMessage(event)
    } else {
      // unsupported other types of event
    }
    next(undefined, false)
  }

  async sendSingleChoiceMessage(event) {
    await this.sendMessage(event, {
      type: 'text',
      text: event.payload.text,
      quickReply: {
        items: event.payload.choices.map(choice => {
          return {
            type: 'action',
            action: {
              type: 'postback',
              label: choice.title,
              data: JSON.stringify({
                type: 'quick_reply',
                text: choice.title,
                payload: choice.value
              }),
              displayText: choice.title
            }
          }
        })
      }
    })
  }

  async sendTextMessage(event) {
    await this.sendMessage(event, {
      type: 'text',
      text: event.payload.text
    })
  }

  async sendImageMessage(event) {
    const imageUrl = process.EXTERNAL_URL + event.payload.image
    await this.sendMessage(event, {
      type: 'image',
      text: event.payload.title,
      originalContentUrl: imageUrl,
      previewImageUrl: imageUrl // TODO: generate preview image by resizing original one
    })
  }

  async sendCarouselMessage(event) {
    await this.sendMessage(event, {
      type: 'template',
      altText: 'this is a carousel template',
      template: {
        type: 'carousel',
        columns: event.payload.items.map(element => {
          const imageUrl = process.EXTERNAL_URL + element.image
          return {
            thumbnailImageUrl: imageUrl,
            imageBackgroundColor: '#FFFFFF',
            title: element.title,
            text: element.subtitle,
            actions: element.actions.map(button => {
              return {
                type: 'message',
                label: button.title,
                text: button.title
              }
            })
          }
        }),
        imageAspectRatio: 'rectangle',
        imageSize: 'cover'
      }
    })
  }

  async sendCardMessage(event: sdk.IO.Event) {
    console.log(event.payload.actions)
    const title = event.payload.subtitle ? event.payload.title : null
    const subtitle = event.payload.subtitle ? event.payload.subtitle : event.payload.title
    const actions = event.payload.actions.map(action => {
      switch (action.action) {
        case 'Say something':
          return {
            type: 'message',
            label: action.title,
            text: action.text
          }
        case 'Open URL':
          return {
            type: 'uri',
            label: action.title,
            uri: action.url
          }
        case 'Postback':
          return {
            type: 'postback',
            label: action.title,
            data: action.payload,
            displayText: action.title
          }
      }
    })
    await this.sendMessage(event, {
      type: 'template',
      altText: 'This is a buttons template',
      template: {
        type: 'buttons',
        thumbnailImageUrl: event.payload.image,
        imageAspectRatio: 'rectangle',
        imageSize: 'cover',
        imageBackgroundColor: '#FFFFFF',
        title,
        text: subtitle,
        // defaultAction: {
        //   type: 'uri',
        //   label: 'View detail',
        //   uri: 'http://example.com/page/123'
        // },
        actions
        // actions: [
        //   {
        //     type: 'postback',
        //     label: 'Buy',
        //     data: 'action=buy&itemid=123'
        //   },
        //   {
        //     type: 'postback',
        //     label: 'Add to cart',
        //     data: 'action=add&itemid=123'
        //   },
        //   {
        //     type: 'uri',
        //     label: 'View detail',
        //     uri: 'http://example.com/page/123'
        //   }
        // ]
      }
    })
  }

  async sendMessage(event: sdk.IO.Event, args: any) {
    const message: any = {
      ...args
    }
    debugOutgoing('Sending message', message)
    try {
      const response = await this.lineClient.pushMessage(event.target, message)
      return response
    } catch (e) {
      console.log(JSON.stringify(e))
      throw e
    }
  }
}

export async function setupMiddleware(bp: typeof sdk, mountedBots: MountedBot[]) {
  bp.events.registerMiddleware({
    description:
      'Sends out messages that targets platform = LINE.' +
      ' This middleware should be placed at the end as it swallows events once sent.',
    direction: 'outgoing',
    handler: outgoingHandler,
    name: MIDDLEWARE_NAME,
    order: 100
  })

  async function outgoingHandler(event: sdk.IO.Event, next: sdk.IO.MiddlewareNextCallback) {
    if (event.channel !== 'line') {
      return next()
    }

    const bot = _.find(mountedBots, { botId: event.botId })
    if (!bot) {
      return next()
    }

    const client: LineClient = bot.client
    return client.handleOutgoingEvent(event, next)
  }
}
