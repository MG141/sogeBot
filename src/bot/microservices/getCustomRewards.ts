import { isMainThread, parentPort, Worker } from 'worker_threads';

import axios from 'axios';
import {
  createConnection,
  getConnection,
  getConnectionOptions,
  getRepository,
} from 'typeorm';
import { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';

import { Settings } from '../database/entity/settings';
import { debug, warning } from '../helpers/log';
import { TypeORMLogger } from '../helpers/logTypeorm';

type CustomRewardEndpoint = { data: { broadcaster_name: string; broadcaster_id: string; id: string; image: string | null; background_color: string; is_enabled: boolean; cost: number; title: string; prompt: string; is_user_input_required: false; max_per_stream_setting: { is_enabled: boolean; max_per_stream: number; }; max_per_user_per_stream_setting: { is_enabled: boolean; max_per_user_per_stream: number }; global_cooldown_setting: { is_enabled: boolean; global_cooldown_seconds: number }; is_paused: boolean; is_in_stock: boolean; default_image: { url_1x: string; url_2x: string; url_4x: string; }; should_redemptions_skip_request_queue: boolean; redemptions_redeemed_current_stream: null | number; cooldown_expires_at: null | string; }[] };
type getCustomRewardReturn = { calls: { remaining: number; refresh: number; limit: number; }; method: string; response: CustomRewardEndpoint; status: number | string; url: string; error: null | string };

const isThreadingEnabled = process.env.THREAD !== '0';

export const getCustomRewards = async (): Promise<getCustomRewardReturn> => {
  debug('microservice', 'getCustomRewards::isThreadingEnabled ' + isThreadingEnabled);
  debug('microservice', 'getCustomRewards::start');
  if (!isMainThread && isThreadingEnabled) {
    debug('microservice', 'getCustomRewards::createConnection');
    const connectionOptions = await getConnectionOptions();
    if (['mysql', 'mariadb'].includes(connectionOptions.type)) {
      await createConnection({
        ...connectionOptions,
        logging: ['error'],
        logger: new TypeORMLogger(),
        synchronize: false,
        migrationsRun: true,
        charset: 'UTF8MB4_GENERAL_CI',
      } as MysqlConnectionOptions);
    } else {
      await createConnection({
        ...connectionOptions,
        logging: ['error'],
        logger: new TypeORMLogger(),
        synchronize: false,
        migrationsRun: true,
      });
    }
    await new Promise( resolve => setTimeout(resolve, 3000) );
  }
  debug('microservice', 'getCustomRewards::getConnection');
  const connection = await getConnection();

  // spin up worker
  if (isMainThread && connection.options.type !== 'better-sqlite3' && isThreadingEnabled) {
    debug('microservice', 'getCustomRewards::worker');
    const value = await new Promise((resolve, reject) => {
      const worker = new Worker(__filename);
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        debug('microservice', 'getCustomRewards::exit with code ' + code);
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    });
    return value as unknown as getCustomRewardReturn;
  }
  try {
    const channelId = JSON.parse((await getRepository(Settings).findOneOrFail({ name: 'channelId' })).value);
    const broadcasterAccessToken = JSON.parse((await getRepository(Settings).findOneOrFail({ name: 'broadcasterAccessToken' })).value);
    const broadcasterClientId = JSON.parse((await getRepository(Settings).findOneOrFail({ name: 'broadcasterClientId' })).value);

    const url = 'https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=' + channelId;
    const request = await axios.get<CustomRewardEndpoint>(url, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + broadcasterAccessToken,
        'Client-ID': broadcasterClientId,
      },
      timeout: 20000,
    });

    const calls = {
      remaining: request.headers['ratelimit-remaining'],
      refresh: request.headers['ratelimit-reset'],
      limit: request.headers['ratelimit-limit'],
    };

    const toReturn = {
      calls,
      method: request.config.method?.toUpperCase() ?? 'GET',
      response: request.data,
      status: request.status,
      url,
      error: null,
    } as const;
    debug('microservice', 'return::getCustomRewards');
    debug('microservice', toReturn);
    if (!isMainThread) {
      parentPort?.postMessage(toReturn);
    }
    return toReturn;
  } catch (e) {
    if (e.message.includes('channelId')) {
      e.message = 'You need to set your channel first.';
      warning('You need to set your channel first.');
    } else {
      warning(e.stack);
    }
    warning('Microservice getCustomRewards ended with error');
    if (e.isAxiosError) {
      const toReturn = {
        calls: {
          remaining: e.response.headers['ratelimit-remaining'],
          refresh: e.response.headers['ratelimit-reset'],
          limit: e.response.headers['ratelimit-limit'],
        },
        url: e.config.url,
        method: e.config.method.toUpperCase(),
        status: e.response?.status ?? 'n/a',
        response: e.response?.data ,
        error: e.message as string,
      } as const;

      debug('microservice', 'getCustomRewards::return');
      debug('microservice', toReturn);
      if (!isMainThread) {
        parentPort?.postMessage(toReturn);
      }
      return toReturn;
    } else {
      const toReturn = {
        calls: {
          remaining: 800,
          refresh: Date.now(),
          limit: 800,
        },
        url: 'n/a',
        method: 'GET',
        status: e.response?.status ?? 'n/a',
        response: { data: [] },
        error: e.message as string,
      };

      debug('microservice', 'getCustomRewards::return');
      debug('microservice', toReturn);
      if (!isMainThread) {
        parentPort?.postMessage(toReturn);
      }
      return toReturn;
    }
  } finally {
    setTimeout(() => {
      if (!isMainThread) {
        debug('microservice', 'getCustomRewards::kill');
        process.exit(0);
      }
    }, 100);
  }
};

if (!isMainThread) {
  // init if not master
  getCustomRewards();
}