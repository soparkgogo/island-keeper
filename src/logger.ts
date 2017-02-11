import * as winston from 'winston';
import { Loggers } from 'island-loggers';

export const logger: winston.LoggerInstance = Loggers.get('island-keeper');
Loggers.switchLevel('island-keeper', process.env.ISLAND_LOGGER_LEVEL || 'info');
