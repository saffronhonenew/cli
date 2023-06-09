import Logger from './logger.js';

export function logger(name) {
  return new Logger().group(name);
}

Object.defineProperties(logger, {
  stdout: { get: () => Logger.stdout },
  stderr: { get: () => Logger.stderr },
  constructor: { get: () => Logger },
  instance: { get: () => new Logger() },
  query: { value: (...args) => logger.instance.query(...args) },
  format: { value: (...args) => logger.instance.format(...args) },
  loglevel: { value: (...args) => logger.instance.loglevel(...args) }
});

export default logger;
