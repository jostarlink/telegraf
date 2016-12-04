class Composer {

  constructor (...handlers) {
    this.handler = Composer.compose(handlers)
  }

  use (...fns) {
    this.handler = Composer.compose([this.handler, ...fns])
    return this
  }

  on (updateTypes, ...fns) {
    return this.use(Composer.mount(updateTypes, Composer.compose(fns)))
  }

  hears (match, ...fns) {
    return this.use(Composer.hears(match, Composer.compose(fns)))
  }

  command (commands, ...fns) {
    return this.use(Composer.command(commands, Composer.compose(fns)))
  }

  action (match, ...fns) {
    return this.use(Composer.action(match, Composer.compose(fns)))
  }

  gameQuery (...fns) {
    return this.use(Composer.gameQuery(Composer.compose(fns)))
  }

  middleware () {
    return this.handler
  }

  static reply (...args) {
    return (ctx) => ctx.reply(...args)
  }

  static fork (middleware) {
    return (ctx, next) => {
      setImmediate(Composer.unwrap(middleware), ctx)
      return next(ctx)
    }
  }

  static passThru () {
    return (ctx, next) => next(ctx)
  }

  static safePassThru () {
    return (ctx, next) => typeof next === 'function' ? next(ctx) : Promise.resolve()
  }

  static lazy (fn) {
    if (typeof fn !== 'function') {
      throw new Error('Argument must be a function')
    }
    return (ctx, next) => Promise.resolve(fn(ctx)).then((middleware) => Composer.unwrap(middleware)(ctx, next))
  }

  static log (logFn = console.log) {
    return Composer.fork((ctx) => logFn(JSON.stringify(ctx.update, null, 2)))
  }

  static branch (match, trueMiddleware, falseMiddleware) {
    if (typeof match !== 'function') {
      return match ? trueMiddleware : falseMiddleware
    }
    return Composer.lazy((ctx) => Promise.resolve(match(ctx)).then((value) => value ? trueMiddleware : falseMiddleware))
  }

  static optional (match, ...fns) {
    return Composer.branch(match, Composer.compose(fns), Composer.passThru())
  }

  static dispatch (match, handlers) {
    if (typeof match !== 'function') {
      return handlers[match] || Composer.passThru()
    }
    return Composer.lazy((ctx) => Promise.resolve(match(ctx)).then((value) => handlers[value]))
  }

  static mount (updateType, middleware) {
    let match = Array.isArray(updateType)
      ? (ctx) => updateType.includes(ctx.updateType) || updateType.includes(ctx.updateSubType)
      : (ctx) => updateType === ctx.updateType || updateType === ctx.updateSubType
    return Composer.optional(match, middleware)
  }

  static hears (match, middleware) {
    return Composer.mount('text', Composer.match(convertMatch(match), middleware))
  }

  static action (match, middleware) {
    return Composer.mount('callback_query', Composer.match(convertMatch(match), middleware))
  }

  static match (matches, middleware) {
    return Composer.lazy((ctx) => {
      const text = (ctx.message && (ctx.message.caption || ctx.message.text)) || (ctx.callbackQuery && ctx.callbackQuery.data)
      for (let match of matches) {
        const result = match(text, ctx)
        if (!result) {
          continue
        }
        ctx.match = result
        return middleware
      }
      return Composer.passThru()
    })
  }

  static acl (userId, middleware) {
    let whitelistFn = userId
    if (typeof whitelistFn !== 'function') {
      const allowed = Array.isArray(userId) ? userId : [userId]
      whitelistFn = (ctx) => allowed.includes(ctx.from.id)
    }
    return Composer.optional(whitelistFn, middleware)
  }

  static gameQuery (middleware) {
    return Composer.mount('callback_query', Composer.optional((ctx) => ctx.callbackQuery.game_short_name, middleware))
  }

  static command (command, middleware) {
    let commands = Array.isArray(command) ? command : [command]
    commands = commands.map((cmd) => cmd.startsWith('/') ? cmd : `/${cmd}`)
    return Composer.mount('text', Composer.lazy((ctx) => {
      const text = ctx.message.text
      const groupCommands = ctx.me && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')
        ? commands.map((command) => `${command}@${ctx.me}`)
        : []
      const hasMatch = ctx.message.entities && ctx.message.entities.find((entity) => {
        const command = text.substring(entity.offset, entity.offset + entity.length)
        return entity.type === 'bot_command' && commands.includes(command) || groupCommands.includes(command)
      })
      return hasMatch ? middleware : Composer.passThru()
    }))
  }

  static unwrap (handler) {
    return handler && typeof handler.middleware === 'function'
    ? handler.middleware()
    : handler
  }

  static compose (middlewares) {
    if (!Array.isArray(middlewares)) {
      throw new Error('Middlewares must be an array')
    }
    if (middlewares.length === 0) {
      return Composer.safePassThru()
    }
    if (middlewares.length === 1) {
      return Composer.unwrap(middlewares[0])
    }
    return (rootCtx, next) => {
      let index = -1
      return execute(0, rootCtx)
      function execute (i, ctx) {
        if (i <= index) {
          return Promise.reject(new Error('next() called multiple times'))
        }
        index = i
        let handler = Composer.unwrap(middlewares[i]) || next
        if (!handler) {
          return Promise.resolve()
        }
        try {
          return Promise.resolve(handler(ctx, (newCtx = ctx) => execute(i + 1, newCtx)))
        } catch (err) {
          return Promise.reject(err)
        }
      }
    }
  }
}

function convertMatch (match) {
  const matches = Array.isArray(match) ? match : [match]
  return matches.map((match) => {
    if (!match) {
      throw new Error('Invalid match')
    }
    if (typeof match === 'function') {
      return match
    }
    return match instanceof RegExp
      ? (value) => match.exec(value || '')
      : (value) => match === value ? value : null
  })
}

module.exports = Composer
