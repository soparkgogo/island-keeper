import { Loggers } from 'island-loggers';
import * as winston from 'winston';

export const logger: winston.LoggerInstance = Loggers.get('island-keeper');
Loggers.switchLevel('island-keeper', process.env.ISLAND_LOGGER_LEVEL || 'info');
