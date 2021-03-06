import querystring from 'querystring';
import { setTimeout } from 'timers';

import axios, { AxiosResponse } from 'axios';
import chalk from 'chalk';
import { chunk, defaults, filter, get, isNil, isNull, map } from 'lodash';
import { Socket } from 'socket.io';
import { getManager, getRepository, In, IsNull, Not } from 'typeorm';

import Core from './_interface';
import * as constants from './constants';
import customvariables from './customvariables';
import { CacheGames } from './database/entity/cacheGames';
import { ThreadEvent } from './database/entity/threadEvent';
import { TwitchClips, TwitchTag, TwitchTagLocalizationDescription, TwitchTagLocalizationName } from './database/entity/twitch';
import { User, UserInterface } from './database/entity/user';
import { persistent } from './decorators';
import { getFunctionList, onStartup } from './decorators/on';
import events from './events';
import { isDbConnected } from './helpers/database';
import { dayjs } from './helpers/dayjs';
import { getBroadcaster } from './helpers/getBroadcaster';
import { triggerInterfaceOnFollow } from './helpers/interface/triggers';
import { isBot, isBotSubscriber } from './helpers/isBot';
import { isBroadcaster } from './helpers/isBroadcaster';
import { isIgnored } from './helpers/isIgnored';
import { debug, error, follow, info, start, stop, unfollow, warning } from './helpers/log';
import { ioServer } from './helpers/panel';
import { linesParsed, setStatus } from './helpers/parser';
import { logAvgTime } from './helpers/profiler';
import { find } from './helpers/register';
import { setImmediateAwait } from './helpers/setImmediateAwait';
import { SQLVariableLimit } from './helpers/sql';
import { getChannelChattersUnofficialAPI } from './microservices/getChannelChattersUnofficialAPI';
import { getCustomRewards } from './microservices/getCustomRewards';
import oauth from './oauth';
import eventlist from './overlays/eventlist';
import { addUIError } from './panel';
import alerts from './registries/alerts';
import stats from './stats';
import { translate } from './translate';
import twitch from './twitch';
import webhooks from './webhooks';
import joinpart from './widgets/joinpart';

let latestFollowedAtTimestamp = 0;

const intervals = new Map<string, {
  interval: number;
  isDisabled: boolean;
  lastRunAt: number;
  opts: Record<string, any>;
}>();

type SubscribersEndpoint = { data: { broadcaster_id: string; broadcaster_name: string; is_gift: boolean; tier: string; plan_name: string; user_id: string; user_name: string; }[], pagination: { cursor: string } };
type FollowsEndpoint = { total: number; data: { from_id: string; from_name: string; to_id: string; toname: string; followed_at: string; }[], pagination: { cursor: string } };
export type StreamEndpoint = { data: { id: string; user_id: string, user_name: string, game_id: string, type: 'live' | '', title: string , viewer_count: number, started_at: string, language: string; thumbnail_url: string; tag_ids: string[] }[], pagination: { cursor: string } };

export const currentStreamTags: {
  is_auto: boolean;
  localization_names: {
    [lang: string]: string;
  };
}[] = [];

const limitProxy = {
  get: function (obj: { limit: number; remaining: number; refresh: number }, prop: 'limit' | 'remaining' | 'refresh') {
    if (typeof obj[prop] === 'undefined') {
      if (prop === 'limit') {
        return 120;
      }
      if (prop === 'remaining') {
        return 800;
      }
      if (prop === 'refresh') {
        return (Date.now() / 1000) + 90;
      }
    } else {
      return obj[prop];
    }
  },
  set: function (obj: { limit: number; remaining: number; refresh: number }, prop: 'limit' | 'remaining' | 'refresh', value: number) {
    if (Number(value) === Number(obj[prop])) {
      return true;
    }
    value = Number(value);
    obj[prop] = value;
    return true;
  },
};

const updateFollowerState = async(users: Readonly<Required<UserInterface>>[], usersFromAPI: { from_name: string; from_id: number; followed_at: string }[], fullScale: boolean) => {
  if (!fullScale) {
    // we are handling only latest followers
    // handle users currently not following
    users.filter(user => !user.isFollower).forEach(user => {
      const apiUser = usersFromAPI.find(userFromAPI => userFromAPI.from_id === user.userId) as typeof usersFromAPI[0];
      if (new Date().getTime() - new Date(apiUser.followed_at).getTime() < 2 * constants.HOUR) {
        if (user.followedAt === 0 || new Date().getTime() - user.followedAt > 60000 * 60 && !webhooks.existsInCache('follows', user.userId)) {
          webhooks.addIdToCache('follows', user.userId);
          eventlist.add({
            event: 'follow',
            userId: String(user.userId),
            timestamp: Date.now(),
          });
          if (!isBot(user.username)) {
            follow(user.username);
            events.fire('follow', { username: user.username, userId: user.userId });
            alerts.trigger({
              event: 'follows',
              name: user.username,
              amount: 0,
              currency: '',
              monthsName: '',
              message: '',
              autohost: false,
            });

            triggerInterfaceOnFollow({
              username: user.username,
              userId: user.userId,
            });
          }
        }
      }
    });
  }
  await getRepository(User).save(
    users.map(user => {
      const apiUser = usersFromAPI.find(userFromAPI => userFromAPI.from_id === user.userId) as typeof usersFromAPI[0];
      return {
        ...user,
        followedAt: user.haveFollowedAtLock ? user.followedAt : new Date(apiUser.followed_at).getTime(),
        isFollower: user.haveFollowerLock? user.isFollower : true,
        followCheckAt: Date.now(),
      };
    }),
    { chunk: Math.floor(SQLVariableLimit / Object.keys(users[0]).length) },
  );
};

const processFollowerState = async (users: { from_name: string; from_id: number; followed_at: string }[], fullScale = false) => {
  const timer = Date.now();
  if (users.length === 0) {
    debug('api.followers', `No followers to process.`);
    return;
  }
  debug('api.followers', `Processing ${users.length} followers`);
  const usersGotFromDb = (await Promise.all(
    chunk(users, SQLVariableLimit).map(async (bulk) => {
      return await getRepository(User).findByIds(bulk.map(user => user.from_id));
    })
  )).flat();
  debug('api.followers', `Found ${usersGotFromDb.length} followers in database`);
  if (users.length > usersGotFromDb.length) {
    const usersSavedToDb = await getRepository(User).save(
      users
        .filter(user => !usersGotFromDb.find(db => db.userId === user.from_id))
        .map(user => {
          return { userId: user.from_id, username: user.from_name };
        }),
      { chunk: Math.floor(SQLVariableLimit / Object.keys(users[0]).length) },
    );
    await updateFollowerState([...usersSavedToDb, ...usersGotFromDb], users, fullScale);
  } else {
    await updateFollowerState(usersGotFromDb, users, fullScale);
  }
  debug('api.followers', `Finished parsing ${users.length} followers in ${Date.now() - timer}ms`);
};

class API extends Core {
  @persistent()
  stats: {
    language: string;
    currentWatchedTime: number;
    currentViewers: number;
    maxViewers: number;
    currentSubscribers: number;
    currentBits: number;
    currentTips: number;
    currentFollowers: number;
    currentViews: number;
    currentGame: string | null;
    currentTitle: string | null;
    currentHosts: number;
    newChatters: number;
  } = {
    language: 'en',
    currentWatchedTime: 0,
    currentViewers: 0,
    maxViewers: 0,
    currentSubscribers: 0,
    currentBits: 0,
    currentTips: 0,
    currentFollowers: 0,
    currentViews: 0,
    currentGame: null,
    currentTitle: null,
    currentHosts: 0,
    newChatters: 0,
  };

  @persistent()
  isStreamOnline = false;
  @persistent()
  streamStatusChangeSince: number =  Date.now();

  @persistent()
  rawStatus = '';

  @persistent()
  gameCache = '';

  calls = {
    bot: new Proxy({ limit: 120, remaining: 800, refresh: (Date.now() / 1000) + 90 }, limitProxy),
    broadcaster: new Proxy({ limit: 120, remaining: 800, refresh: (Date.now() / 1000) + 90 }, limitProxy),
  };
  chatMessagesAtStart = linesParsed;
  maxRetries = 3;
  curRetries = 0;
  streamType = 'live';
  streamId: null | string = null;
  gameOrTitleChangedManually = false;

  retries = {
    getCurrentStreamData: 0,
    getChannelInformation: 0,
    getChannelSubscribers: 0,
  };

  constructor () {
    super();
    this.addMenu({ category: 'stats', name: 'api', id: 'stats/api', this: null });

    this.interval('getCurrentStreamData', constants.MINUTE);
    this.interval('getCurrentStreamTags', constants.MINUTE);
    this.interval('updateChannelViewsAndBroadcasterType', constants.HOUR);
    this.interval('getLatest100Followers', constants.MINUTE);
    this.interval('getChannelFollowers', constants.DAY);
    this.interval('getChannelHosts', 10 * constants.MINUTE);
    this.interval('getChannelSubscribers', 2 * constants.MINUTE);
    this.interval('getChannelChattersUnofficialAPI', 5 * constants.MINUTE);
    this.interval('getChannelInformation', constants.MINUTE);
    this.interval('checkClips', constants.MINUTE);
    this.interval('getAllStreamTags', constants.DAY);
    this.interval('getModerators', 10 * constants.MINUTE);

    setTimeout(() => {
      // free thread_event
      getManager()
        .createQueryBuilder()
        .delete()
        .from(ThreadEvent)
        .where('event = :event', { event: 'getChannelChattersUnofficialAPI' })
        .execute();
    }, 30000);
  }

  async setRateLimit (type: 'bot' | 'broadcaster', limit: number, remaining: number, refresh: number) {
    this.calls[type].limit = limit;
    this.calls[type].remaining = remaining;
    this.calls[type].refresh = refresh;
  }

  interval(fnc: string, interval: number) {
    intervals.set(fnc, {
      interval, lastRunAt: 0, opts: {}, isDisabled: false,
    });
  }

  @onStartup()
  async intervalCheck () {
    const check = async () => {
      for (const fnc of intervals.keys()) {
        await setImmediateAwait();
        debug('api.interval', chalk.yellow(fnc + '() ') + 'check');
        if (oauth.loadedTokens < 2) {
          debug('api.interval', chalk.yellow(fnc + '() ') + 'tokens not loaded yet.');
          return;
        }
        let interval = intervals.get(fnc);
        if (!interval) {
          error(`Interval ${fnc} not found.`);
          continue;
        }
        if (interval.isDisabled) {
          debug('api.interval', chalk.yellow(fnc + '() ') + 'disabled');
          continue;
        }
        if (Date.now() - interval.lastRunAt >= interval.interval) {
          debug('api.interval', chalk.yellow(fnc + '() ') + 'start');
          const time = process.hrtime();
          const time2 = Date.now();
          try {
            const value = await Promise.race<Promise<any>>([
              new Promise((resolve) => (this as any)[fnc](interval?.opts).then((data: any) => resolve(data))),
              new Promise((_resolve, reject) => setTimeout(() => reject(), 10 * constants.MINUTE)),
            ]);
            logAvgTime(`api.${fnc}()`, process.hrtime(time));
            debug('api.interval', chalk.yellow(fnc + '(time: ' + (Date.now() - time2 + ') ') + JSON.stringify(value)));
            intervals.set(fnc, {
              ...interval,
              lastRunAt: Date.now(),
            });
            if (value.disable) {
              intervals.set(fnc, {
                ...interval,
                isDisabled: true,
              });
              debug('api.interval', chalk.yellow(fnc + '() ') + 'disabled');
              continue;
            }
            debug('api.interval', chalk.yellow(fnc + '() ') + 'done, value:' + JSON.stringify(value));

            interval = intervals.get(fnc); // refresh data
            if (!interval) {
              error(`Interval ${fnc} not found.`);
              continue;
            }

            if (value.state) { // if is ok, update opts and run unlock after a while
              intervals.set(fnc, {
                ...interval,
                opts: value.opts ?? {},
              });
            } else { // else run next tick
              intervals.set(fnc, {
                ...interval,
                opts: value.opts ?? {},
                lastRunAt: 0,
              });
            }
          } catch (e) {
            warning(`API call for ${fnc} is probably frozen (took more than 10minutes), forcefully unblocking`);
            continue;
          }
        } else {
          debug('api.interval', chalk.yellow(fnc + '() ') + `skip run, lastRunAt: ${interval.lastRunAt}`,  );
        }
      }
    };
    setInterval(check, 10000);
  }

  async getModerators(opts: { isWarned: boolean }) {
    const token = oauth.broadcasterAccessToken;
    const needToWait = token === '';
    const notEnoughAPICalls = this.calls.broadcaster.remaining <= 30 && this.calls.broadcaster.refresh > Date.now() / 1000;
    const missingBroadcasterId = oauth.broadcasterId.length === 0;

    if (!oauth.broadcasterCurrentScopes.includes('moderation:read')) {
      if (!opts.isWarned) {
        opts.isWarned = true;
        warning('Missing Broadcaster oAuth scope moderation:read to read channel moderators.');
        addUIError({ name: 'OAUTH', message: 'Missing Broadcaster oAuth scope moderation:read to read channel moderators.' });
      }
      return { state: false, opts };
    }

    if ((needToWait || notEnoughAPICalls || missingBroadcasterId)) {
      return { state: false };
    }
    const url = `https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${oauth.broadcasterId}`;
    try {
      const request = await axios.request<{ pagination: any, data: { user_id: string; user_name: string }[] }>({
        method: 'get',
        url,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.broadcasterClientId,
          'Content-Type': 'application/json',
        },
      });

      // save remaining api calls
      this.calls.broadcaster.remaining = request.headers['ratelimit-remaining'];
      this.calls.broadcaster.refresh = request.headers['ratelimit-reset'];
      this.calls.broadcaster.limit = request.headers['ratelimit-limit'];

      const data = request.data.data;
      await getRepository(User).update({
        userId: Not(In(data.map(o => Number(o.user_id)))),
      }, { isModerator: false });
      await getRepository(User).update({
        userId: In(data.map(o => Number(o.user_id))),
      }, { isModerator: true });

      setStatus('MOD', data.map(o => o.user_id).includes(oauth.botId));
    } catch (e) {
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getModerators', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.broadcaster });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getModerators', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.broadcaster });
      }
    }
    return { state: true };
  }

  async followerUpdatePreCheck (username: string) {
    const user = await getRepository(User).findOne({ username });
    if (user) {
      const isSkipped = user.username === getBroadcaster() || user.username === oauth.botUsername;
      const userHaveId = !isNil(user.userId);
      if (new Date().getTime() - user.followCheckAt <= constants.DAY || isSkipped || !userHaveId) {
        return;
      }
      await this.isFollowerUpdate(user);
    }
  }

  async getUsernameFromTwitch (id: number) {
    const url = `https://api.twitch.tv/helix/users?id=${id}`;
    let request;
    /*
      {
        "data": [{
          "id": "44322889",
          "login": "dallas",
          "display_name": "dallas",
          "type": "staff",
          "broadcaster_type": "",
          "description": "Just a gamer playing games and chatting. :)",
          "profile_image_url": "https://static-cdn.jtvnw.net/jtv_user_pictures/dallas-profile_image-1a2c906ee2c35f12-300x300.png",
          "offline_image_url": "https://static-cdn.jtvnw.net/jtv_user_pictures/dallas-channel_offline_image-1a2c906ee2c35f12-1920x1080.png",
          "view_count": 191836881,
          "email": "login@provider.com"
        }]
      }
    */

    const token = oauth.botAccessToken;
    const needToWait = token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;
    if ((needToWait || notEnoughAPICalls)) {
      return null;
    }

    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.limit = request.headers['ratelimit-limit'];
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getUsernameFromTwitch', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
      return request.data.data[0].login;
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getUsernameFromTwitch', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
    }
    return null;
  }

  async getIdFromTwitch (username: string, isChannelId = false): Promise<string> {
    const url = `https://api.twitch.tv/helix/users?login=${username}`;
    let request;
    /*
      {
        "data": [{
          "id": "44322889",
          "login": "dallas",
          "display_name": "dallas",
          "type": "staff",
          "broadcaster_type": "",
          "description": "Just a gamer playing games and chatting. :)",
          "profile_image_url": "https://static-cdn.jtvnw.net/jtv_user_pictures/dallas-profile_image-1a2c906ee2c35f12-300x300.png",
          "offline_image_url": "https://static-cdn.jtvnw.net/jtv_user_pictures/dallas-channel_offline_image-1a2c906ee2c35f12-1920x1080.png",
          "view_count": 191836881,
          "email": "login@provider.com"
        }]
      }
    */

    const token = oauth.botAccessToken;
    const needToWait = token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;
    if ((needToWait || notEnoughAPICalls) && !isChannelId) {
      throw new Error('API calls not available.');
    }

    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.limit = request.headers['ratelimit-limit'];
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getIdFromTwitch', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      return String(request.data.data[0].id);
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];

        ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getIdFromTwitch', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      } else {
        ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getIdFromTwitch', api: 'helix', endpoint: url, code: 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      throw new Error(`User ${username} not found on Twitch.`);
    }
  }

  async getChannelChattersUnofficialAPI (opts: any) {
    const oAuthIsSet = oauth.botUsername.length > 0
      && oauth.channelId.length > 0
      && oauth.currentChannel.length > 0;

    if (!isDbConnected || !oAuthIsSet) {
      return { state: false, opts };
    }

    const event = await getRepository(ThreadEvent).findOne({ event: 'getChannelChattersUnofficialAPI' });
    if (typeof event === 'undefined') {
      const { partedUsers, joinedUsers } = await getChannelChattersUnofficialAPI();
      ioServer?.emit('api.stats', { method: 'GET', data: { partedUsers, joinedUsers }, timestamp: Date.now(), call: 'getChannelChattersUnofficialAPI', api: 'unofficial', endpoint: `https://tmi.twitch.tv/group/user/${oauth.broadcasterUsername}/chatters`, code: 200, remaining: 'n/a' });

      joinpart.send({ users: partedUsers, type: 'part' });
      for (const username of partedUsers) {
        if (!isIgnored({ username: username })) {
          await setImmediateAwait();
          events.fire('user-parted-channel', { username });
        }
      }

      joinpart.send({ users: joinedUsers, type: 'join' });
      for (const username of joinedUsers) {
        if (isIgnored({ username }) || oauth.botUsername === username) {
          continue;
        } else {
          await setImmediateAwait();
          this.followerUpdatePreCheck(username);
          events.fire('user-joined-channel', { username });
        }
      }
    }
    return { state: true, opts };
  }

  async getAllStreamTags(opts: { cursor?: string }): Promise<{ state: boolean, opts: { cursor?: string} }> {
    let url = `https://api.twitch.tv/helix/tags/streams?first=100`;
    if (opts.cursor) {
      url += '&after=' + opts.cursor;
    }

    const token = oauth.botAccessToken;
    const needToWait = token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;

    if (needToWait || notEnoughAPICalls) {
      return { state: false, opts };
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });
      const tags = request.data.data;

      for(const tag of tags) {
        const localizationNames = await getRepository(TwitchTagLocalizationName).find({ tagId: tag.tag_id });
        const localizationDescriptions = await getRepository(TwitchTagLocalizationDescription).find({ tagId: tag.tag_id });
        await getRepository(TwitchTag).save({
          tag_id: tag.tag_id,
          is_auto: tag.is_auto,
          localization_names: Object.keys(tag.localization_names).map(key => {
            return {
              id: localizationNames.find(o => o.locale === key && o.tagId === tag.tag_id)?.id,
              locale: key,
              value: tag.localization_names[key],
            };
          }),
          localization_descriptions: Object.keys(tag.localization_descriptions).map(key => {
            return {
              id: localizationDescriptions.find(o => o.locale === key && o.tagId === tag.tag_id)?.id,
              locale: key,
              value: tag.localization_descriptions[key],
            };
          }),
        });
      }
      await getRepository(TwitchTagLocalizationDescription).delete({ tagId: IsNull() });
      await getRepository(TwitchTagLocalizationName).delete({ tagId: IsNull() });

      ioServer?.emit('api.stats', { method: 'GET', data: tags, timestamp: Date.now(), call: 'getAllStreamTags', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      if (tags.length === 100) {
        // move to next page
        return this.getAllStreamTags({ cursor: request.data.pagination.cursor });
      }
    } catch (e) {
      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getAllStreamTags', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
    }
    delete opts.cursor;
    return { state: true, opts };

  }

  async getChannelSubscribers<T extends { cursor?: string; count?: number; noAffiliateOrPartnerWarningSent?: boolean; notCorrectOauthWarningSent?: boolean; subscribers?: SubscribersEndpoint['data'] }> (opts: T): Promise<{ state: boolean; opts: T }> {
    opts = opts || {};

    const cid = oauth.channelId;
    let url = `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${cid}&first=100`;
    if (opts.cursor) {
      url += '&after=' + opts.cursor;
    }
    if (typeof opts.count === 'undefined') {
      opts.count = -1;
    } // start at -1 because owner is subbed as well

    const token = oauth.broadcasterAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.broadcaster.remaining <= 30 && this.calls.broadcaster.refresh > Date.now() / 1000;

    if (needToWait || notEnoughAPICalls || oauth.broadcasterType === '') {
      if (oauth.broadcasterType === '') {
        if (!opts.noAffiliateOrPartnerWarningSent) {
          warning('Broadcaster is not affiliate/partner, will not check subs');
          this.stats.currentSubscribers = 0;
        }
        delete opts.count;
        return { state: false, opts: { ...opts, noAffiliateOrPartnerWarningSent: true } };
      } else {
        return { state: false, opts: { ...opts, noAffiliateOrPartnerWarningSent: false } };
      }
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      }) as AxiosResponse<SubscribersEndpoint>;
      const subscribers = request.data.data;
      if (opts.subscribers) {
        opts.subscribers = [...subscribers, ...opts.subscribers];
      } else {
        opts.subscribers = subscribers;
      }

      ioServer?.emit('api.stats', { method: 'GET', data: subscribers, timestamp: Date.now(), call: 'getChannelSubscribers', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      // save remaining api calls
      this.calls.broadcaster.remaining = request.headers['ratelimit-remaining'];
      this.calls.broadcaster.refresh = request.headers['ratelimit-reset'];
      this.calls.broadcaster.limit = request.headers['ratelimit-limit'];

      if (subscribers.length === 100) {
        // move to next page
        return this.getChannelSubscribers({ ...opts, cursor: request.data.pagination.cursor, count: opts.subscribers.length + opts.count, subscribers: opts.subscribers });
      } else {
        this.stats.currentSubscribers = subscribers.length + opts.count;
        this.setSubscribers(opts.subscribers.filter(o => !isBroadcaster(o.user_name) && !isBot(o.user_name)));
        if (opts.subscribers.find(o => isBot(o.user_name))) {
          isBotSubscriber(true);
        } else {
          isBotSubscriber(false);
        }
      }

      // reset warning after correct calls (user may have affiliate or have correct oauth)
      opts.noAffiliateOrPartnerWarningSent = false;
      opts.notCorrectOauthWarningSent = false;
    } catch (e) {
      if ((e.message === '403 Forbidden' || e.message === 'Request failed with status code 401')) {
        if (!opts.notCorrectOauthWarningSent) {
          opts.notCorrectOauthWarningSent = true;
          warning('Broadcaster have not correct oauth, will not check subs');
        }
        this.stats.currentSubscribers = 0;
      } else {
        error(`${url} - ${e.stack}`);

        ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getChannelSubscribers', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
    }
    delete opts.count;
    return { state: true, opts };
  }

  async setSubscribers (subscribers: SubscribersEndpoint['data']) {
    const currentSubscribers = await getRepository(User).find({
      where: {
        isSubscriber: true,
      },
    });

    // check if current subscribers are still subs
    for (const user of currentSubscribers) {
      if (!user.haveSubscriberLock && !subscribers
        .map((o) => String(o.user_id))
        .includes(String(user.userId))) {
        // subscriber is not sub anymore -> unsub and set subStreak to 0
        await getRepository(User).save({
          ...user,
          isSubscriber: false,
          subscribeStreak: 0,
        });
      }
    }

    // update subscribers tier and set them active
    for (const user of subscribers) {
      const current = currentSubscribers.find(o => Number(o.userId) === Number(user.user_id));
      const isNotCurrentSubscriber = !current;
      const valuesNotMatch = current && (current.subscribeTier !== String(Number(user.tier) / 1000) || current.isSubscriber === false);
      if (isNotCurrentSubscriber || valuesNotMatch) {
        await getRepository(User).update({
          userId: Number(user.user_id),
        },
        {
          username: user.user_name.toLowerCase(),
          isSubscriber: true,
          subscribeTier: String(Number(user.tier) / 1000),
        });
      }
    }
  }

  async getChannelInformation (opts: any) {
    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/channels?broadcaster_id=${cid}`;

    // getChannelInformation only if stream is offline - we are using getCurrentStreamData for online stream title/game
    if (this.isStreamOnline) {
      this.retries.getChannelInformation = 0;
      return { state: true, opts };
    }

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    if (needToWait) {
      return { state: false, opts };
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });
      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data.data, timestamp: Date.now(), call: 'getChannelInformation', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      if (!this.gameOrTitleChangedManually) {
        // Just polling update
        let rawStatus = this.rawStatus;
        const title = await this.parseTitle(null);

        if (request.data.data[0].title !== title && this.retries.getChannelInformation === -1) {
          return { state: true, opts };
        } else if (request.data.data[0].title !== title && !opts.forceUpdate) {
          // check if title is same as updated title
          const numOfRetries = twitch.isTitleForced ? 1 : 15;
          if (this.retries.getChannelInformation >= numOfRetries) {
            this.retries.getChannelInformation = 0;

            // if we want title to be forced
            if (twitch.isTitleForced) {
              const game = this.gameCache;
              info(`Title/game force enabled => ${game} | ${rawStatus}`);
              this.setTitleAndGame({});
              return { state: true, opts };
            } else {
              info(`Title/game changed outside of a bot => ${request.data.data[0].game_name} | ${request.data.data[0].title}`);
              this.retries.getChannelInformation = -1;
              rawStatus = request.data.data[0].title;
            }
          } else {
            this.retries.getChannelInformation++;
            return { state: false, opts };
          }
        } else {
          this.retries.getChannelInformation = 0;
        }

        this.stats.language = request.data.data[0].broadcaster_language;
        this.stats.currentGame = request.data.data[0].game_name;
        this.stats.currentTitle = request.data.data[0].title;
        this.gameCache = request.data.data[0].game_name;
        this.rawStatus = rawStatus;
      } else {
        this.gameOrTitleChangedManually = false;
      }
    } catch (e) {
      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getChannelInformation', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      return { state: false, opts };
    }

    this.retries.getChannelInformation = 0;
    return { state: true, opts };
  }

  async getChannelHosts () {
    const cid = oauth.channelId;

    if (isNil(cid) || cid === '') {
      return { state: false };
    }

    let request;
    const url = `http://tmi.twitch.tv/hosts?include_logins=1&target=${cid}`;
    try {
      request = await axios.get(url);
      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getChannelHosts', api: 'other', endpoint: url, code: request.status, remaining: this.calls.bot });
      this.stats.currentHosts = request.data.hosts.length;
    } catch (e) {
      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getChannelHosts', api: 'other', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      return { state: e.response?.status === 500 };
    }

    return { state: true };
  }

  async updateChannelViewsAndBroadcasterType () {
    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/users/?id=${cid}`;

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;
    if (needToWait || notEnoughAPICalls) {
      return { state: false };
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
      });
      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'updateChannelViewsAndBroadcasterType', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      if (request.data.data.length > 0) {
        oauth.profileImageUrl = request.data.data[0].profile_image_url;
        oauth.broadcasterType = request.data.data[0].broadcaster_type;
        this.stats.currentViews = request.data.data[0].view_count;
      }
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }

      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'updateChannelViewsAndBroadcasterType', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
    }
    return { state: true };
  }

  async getLatest100Followers () {
    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/users/follows?to_id=${cid}&first=100`;
    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;

    if (needToWait || notEnoughAPICalls) {
      return { state: false };
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      }) as AxiosResponse<FollowsEndpoint>;

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getLatest100Followers', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      if (request.status === 200 && !isNil(request.data.data)) {
        // we will go through only new users
        if (request.data.data.length > 0 && new Date(request.data.data[0].followed_at).getTime() !== latestFollowedAtTimestamp) {
          processFollowerState(request.data.data
            .filter(f => latestFollowedAtTimestamp < new Date(f.followed_at).getTime())
            .map(f => {
              return {
                from_name: String(f.from_name).toLowerCase(),
                from_id: Number(f.from_id),
                followed_at: f.followed_at,
              };
            }));
          latestFollowedAtTimestamp = new Date(request.data.data[0].followed_at).getTime();
        } else {
          debug('api.followers', 'No new followers found.');
        }
      }
      this.stats.currentFollowers =  request.data.total;
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }

      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getLatest100Followers', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      return { state: false };
    }
    return { state: true };
  }

  async getChannelFollowers (opts: any) {
    opts = opts || {};

    const cid = oauth.channelId;

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;

    if (needToWait || notEnoughAPICalls) {
      return { state: false, opts };
    }

    let url = `https://api.twitch.tv/helix/users/follows?to_id=${cid}&first=100`;
    if (opts.cursor) {
      url += '&after=' + opts.cursor;
    } else {
      debug('api.getChannelFollowers', 'started');
    }

    try {
      const request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      }) as AxiosResponse<FollowsEndpoint>;

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getChannelFollowers', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      if (request.status === 200 && !isNil(request.data.data)) {
        const followers = request.data.data;

        ioServer?.emit('api.stats', { method: 'GET', data: followers, timestamp: Date.now(), call: 'getChannelFollowers', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

        debug('api.getChannelFollowers', `Followers loaded: ${followers.length}, cursor: ${request.data.pagination.cursor}`);
        debug('api.getChannelFollowers', `Followers list: \n\t${followers.map(o => o.from_name)}`);

        // process each 100 not full scale at once
        processFollowerState(followers.map(f => {
          return {
            from_name: String(f.from_name).toLowerCase(),
            from_id: Number(f.from_id),
            followed_at: f.followed_at,
          };
        }), true).then(async () => {
          if (followers.length === 100) {
            // move to next page
            // we don't care about return
            setImmediateAwait().then(() => {
              this.getChannelFollowers({ cursor: request.data.pagination.cursor });
            });
          }
        });
      }
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }

      error(`${url} - ${e.stack}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getChannelFollowers', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
    }
    // return from first page (but we will still go through all pages)
    delete opts.cursor;
    return { state: true, opts };
  }

  async getGameNameFromId (id: number) {
    let request;
    const url = `https://api.twitch.tv/helix/games?id=${id}`;

    if (id.toString().trim().length === 0 || id === 0) {
      return '';
    } // return empty game if gid is empty

    const gameFromDb = await getRepository(CacheGames).findOne({ id });

    // check if id is cached
    if (gameFromDb) {
      return gameFromDb.name;
    }

    try {
      const token = oauth.botAccessToken;
      if (token === '') {
        throw new Error('token not available');
      }
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];
      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getGameNameFromId', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      // add id->game to cache
      const name = request.data.data[0].name;
      await getRepository(CacheGames).save({ id, name });
      return name;
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }

      warning(`Couldn't find name of game for gid ${id} - fallback to ${this.stats.currentGame}`);
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getGameNameFromId', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getGameNameFromId', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      return this.stats.currentGame;
    }
  }

  async getGameIdFromName (name: string): Promise<number | null> {
    let request;
    const url = `https://api.twitch.tv/helix/games?name=${encodeURIComponent(name)}`;

    const gameFromDb = await getRepository(CacheGames).findOne({ name });

    // check if name is cached
    if (gameFromDb) {
      return gameFromDb.id;
    }

    try {
      const token = oauth.botAccessToken;
      if (token === '') {
        throw new Error('token not available');
      }
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];
      ioServer?.emit('api.stats', { method: request.config.method?.toUpperCase(), data: request.data, timestamp: Date.now(), call: 'getGameIdFromName', api: 'helix', endpoint: request.config.url, code: request.status, remaining: this.calls.bot });

      // add id->game to cache
      const id = Number(request.data.data[0].id);
      await getRepository(CacheGames).save({ id, name });
      return id;
    } catch (e) {
      warning(`Couldn't find name of game for name ${name} - fallback to ${this.stats.currentGame}`);
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getGameIdFromName', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getGameIdFromName', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      return null;
    }
  }

  async getCurrentStreamTags (opts: any) {
    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/streams/tags?broadcaster_id=${cid}`;

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;
    if (needToWait || notEnoughAPICalls) {
      return { state: false, opts };
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getCurrentStreamTags', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      if (request.status === 200 && !isNil(request.data.data[0])) {
        const tags = request.data.data;
        while (currentStreamTags.length) {
          currentStreamTags.pop();
        }
        for (const tag of tags) {
          currentStreamTags.push({
            is_auto: tag.is_auto, localization_names: tag.localization_names,
          });
        }
      }
    } catch (e) {
      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getCurrentStreamTags', api: 'getCurrentStreamTags', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      return { state: false, opts };
    }
    return { state: true, opts };
  }

  async getCurrentStreamData (opts: any) {
    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/streams?user_id=${cid}`;

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;
    if (needToWait || notEnoughAPICalls) {
      return { state: false, opts };
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      }) as AxiosResponse<StreamEndpoint>;

      setStatus('API', request.status === 200 ? constants.CONNECTED : constants.DISCONNECTED);

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getCurrentStreamData', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      let justStarted = false;

      debug('api.stream', 'API: ' + JSON.stringify(request.data));

      if (request.status === 200 && request.data.data[0]) {
        // correct status and we've got a data - stream online
        const stream = request.data.data[0];

        if (dayjs(stream.started_at).valueOf() >=  dayjs(this.streamStatusChangeSince).valueOf()) {
          this.streamStatusChangeSince = (new Date(stream.started_at)).getTime();
        }
        if (!this.isStreamOnline || this.streamType !== stream.type) {
          this.chatMessagesAtStart = linesParsed;

          if (!webhooks.enabled.streams && Number(this.streamId) !== Number(stream.id)) {
            debug('api.stream', 'API: ' + JSON.stringify(stream));
            start(
              `id: ${stream.id} | startedAt: ${stream.started_at} | title: ${stream.title} | game: ${await this.getGameNameFromId(Number(stream.game_id))} | type: ${stream.type} | channel ID: ${cid}`
            );

            // reset quick stats on stream start
            this.stats.currentWatchedTime = 0;
            this.stats.maxViewers = 0;
            this.stats.newChatters = 0;
            this.stats.currentViewers = 0;
            this.stats.currentBits = 0;
            this.stats.currentTips = 0;

            this.streamStatusChangeSince = new Date(stream.started_at).getTime();
            this.streamId = stream.id;
            this.streamType = stream.type;

            events.fire('stream-started', {});
            events.fire('command-send-x-times', { reset: true });
            events.fire('keyword-send-x-times', { reset: true });
            events.fire('every-x-minutes-of-stream', { reset: true });
            justStarted = true;

            for (const event of getFunctionList('streamStart')) {
              const type = !event.path.includes('.') ? 'core' : event.path.split('.')[0];
              const module = !event.path.includes('.') ? event.path.split('.')[0] : event.path.split('.')[1];
              const self = find(type, module);
              if (self) {
                (self as any)[event.fName]();
              } else {
                error(`streamStart: ${event.path} not found`);
              }
            }
          }
        }

        this.curRetries = 0;
        this.saveStreamData(stream);
        this.isStreamOnline = true;

        if (!justStarted) {
          // don't run events on first check
          events.fire('number-of-viewers-is-at-least-x', {});
          events.fire('stream-is-running-x-minutes', {});
          events.fire('every-x-minutes-of-stream', {});
        }

        if (!this.gameOrTitleChangedManually) {
          let rawStatus = this.rawStatus;
          const status = await this.parseTitle(null);
          const game = await this.getGameNameFromId(Number(stream.game_id));

          this.stats.currentTitle = stream.title;
          this.stats.currentGame = game;

          if (stream.title !== status) {
            // check if status is same as updated status
            if (this.retries.getCurrentStreamData >= 12) {
              this.retries.getCurrentStreamData = 0;
              rawStatus = stream.title;
              this.rawStatus = rawStatus;
            } else {
              this.retries.getCurrentStreamData++;
              return { state: false, opts };
            }
          } else {
            this.retries.getCurrentStreamData = 0;
          }
          this.gameCache = game;
          this.rawStatus = rawStatus;
        }
      } else {
        if (this.isStreamOnline && this.curRetries < this.maxRetries) {
          // retry if it is not just some network / twitch issue
          this.curRetries = this.curRetries + 1;
        } else {
          // stream is really offline
          if (this.isStreamOnline) {
            // online -> offline transition
            stop('');
            this.streamStatusChangeSince = Date.now();
            this.isStreamOnline = false;
            this.curRetries = 0;
            events.fire('stream-stopped', {});
            events.fire('stream-is-running-x-minutes', { reset: true });
            events.fire('number-of-viewers-is-at-least-x', { reset: true });

            for (const event of getFunctionList('streamEnd')) {
              const type = !event.path.includes('.') ? 'core' : event.path.split('.')[0];
              const module = !event.path.includes('.') ? event.path.split('.')[0] : event.path.split('.')[1];
              const self = find(type, module);
              if (self) {
                (self as any)[event.fName]();
              } else {
                error(`streamEnd: ${event.path} not found`);
              }
            }

            this.streamId = null;
          }
        }
      }
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }

      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getCurrentStreamData', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      return { state: false, opts };
    }
    return { state: true, opts };
  }

  saveStreamData (stream: StreamEndpoint['data'][number]) {
    this.stats.currentViewers = stream.viewer_count;

    if (this.stats.maxViewers < stream.viewer_count) {
      this.stats.maxViewers = stream.viewer_count;
    }

    stats.save({
      timestamp: new Date().getTime(),
      whenOnline: this.isStreamOnline ? this.streamStatusChangeSince : Date.now(),
      currentViewers: this.stats.currentViewers,
      currentSubscribers: this.stats.currentSubscribers,
      currentFollowers: this.stats.currentFollowers,
      currentBits: this.stats.currentBits,
      currentTips: this.stats.currentTips,
      chatMessages: linesParsed - this.chatMessagesAtStart,
      currentViews: this.stats.currentViews,
      maxViewers: this.stats.maxViewers,
      newChatters: this.stats.newChatters,
      currentHosts: this.stats.currentHosts,
      currentWatched: this.stats.currentWatchedTime,
    });
  }

  async parseTitle (title: string | null) {
    if (isNil(title)) {
      title = this.rawStatus;
    }

    const regexp = new RegExp('\\$_[a-zA-Z0-9_]+', 'g');
    const match = title.match(regexp);

    if (!isNil(match)) {
      for (const variable of match) {
        let value;
        if (await customvariables.isVariableSet(variable)) {
          value = await customvariables.getValueOf(variable);
        } else {
          value = translate('webpanel.not-available');
        }
        title = title.replace(new RegExp(`\\${variable}`, 'g'), value);
      }
    }
    return title;
  }

  async setTags (tagsArg: string[]) {
    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/streams/tags?broadcaster_id=${cid}`;

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    if (needToWait) {
      setTimeout(() => this.setTags(tagsArg), 1000);
      return;
    }

    const tag_ids: string[] = [];
    try {
      for (const tag of tagsArg) {
        const name = await getRepository(TwitchTagLocalizationName).findOne({
          where: {
            value: tag,
            tagId: Not(IsNull()),
          },
        });
        if (name && name.tagId) {
          tag_ids.push(name.tagId);
        }
      }

      const request = await axios({
        method: 'put',
        url,
        data: {
          tag_ids,
        },
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Client-ID': oauth.botClientId,
        },
      });
      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      await getRepository(TwitchTag).update({ is_auto: false }, { is_current: false });
      for (const tag_id of tag_ids) {
        await getRepository(TwitchTag).update({ tag_id }, { is_current: true });
      }
      ioServer?.emit('api.stats', { method: 'PUT', request: { data: { tag_ids } }, timestamp: Date.now(), call: 'setTags', api: 'helix', endpoint: url, code: request.status, data: request.data, remaining: this.calls.bot });
    } catch (e) {
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'setTags', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'setTags', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      return false;
    }

  }

  async setTitleAndGame (args: { title?: string | null; game?: string | null }): Promise<{ response: string; status: boolean } | null> {
    args = defaults(args, { title: null }, { game: null });
    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/channels?broadcaster_id=${cid}`;

    const token = oauth.broadcasterAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';

    if (!oauth.broadcasterCurrentScopes.includes('channel_editor')) {
      warning('Missing Broadcaster oAuth scope channel_editor to change game or title. This mean you can have inconsistent game set across Twitch: https://github.com/twitchdev/issues/issues/224');
      addUIError({ name: 'OAUTH', message: 'Missing Broadcaster oAuth scope channel_editor to change game or title. This mean you can have inconsistent game set across Twitch: <a href="https://github.com/twitchdev/issues/issues/224">Twitch Issue # 224</a>' });
    }
    if (!oauth.broadcasterCurrentScopes.includes('user:edit:broadcast')) {
      warning('Missing Broadcaster oAuth scope user:edit:broadcast to change game or title');
      addUIError({ name: 'OAUTH', message: 'Missing Broadcaster oAuth scope user:edit:broadcast to change game or title' });
      return { response: '', status: false };
    }
    if (needToWait) {
      warning('Missing Broadcaster oAuth to change game or title');
      addUIError({ name: 'OAUTH', message: 'Missing Broadcaster oAuth to change game or title' });
      return { response: '', status: false };
    }

    let request;
    let title;
    let game;

    let requestData = '';
    try {
      if (!isNil(args.title)) {
        this.rawStatus = args.title; // save raw status to cache, if changing title
      }
      title = await this.parseTitle(this.rawStatus);

      if (!isNil(args.game)) {
        game = args.game;
        this.gameCache = args.game; // save game to cache, if changing gae
      } else {
        game = this.gameCache;
      } // we are not setting game -> load last game

      requestData = JSON.stringify({
        game_id: await this.getGameIdFromName(game), title,
      });

      /* workaround for https://github.com/twitchdev/issues/issues/224
       * Modify Channel Information is not propagated correctly on twitch #224
       */
      try {
        await axios({
          method: 'put',
          url: `https://api.twitch.tv/kraken/channels/${cid}`,
          data: {
            channel: {
              game: game,
              status: title,
            },
          },
          headers: {
            'Accept': 'application/vnd.twitchtv.v5+json',
            'Authorization': 'OAuth ' + oauth.broadcasterAccessToken,
          },
        });
      } catch (e) {
        error(`API: https://api.twitch.tv/kraken/channels/${cid} - ${e.message}`);
      }

      request = await axios({
        method: 'patch',
        url,
        data: requestData,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.broadcasterClientId,
          'Content-Type': 'application/json',
        },
      });
      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'PATCH', request: requestData, timestamp: Date.now(), call: 'setTitleAndGame', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
    } catch (e) {
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'setTitleAndGame', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'setTitleAndGame', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      return { response: '', status: false };
    }

    const responses: { response: string; status: boolean } = { response: '', status: false };

    if (request.status === 204) {
      if (!isNil(args.game)) {
        responses.response = translate('game.change.success').replace(/\$game/g, args.game);
        responses.status = true;
        if (this.stats.currentGame !== args.game) {
          events.fire('game-changed', { oldGame: this.stats.currentGame, game: args.game });
        }
        this.stats.currentGame = args.game;
      }

      if (!isNil(args.title)) {
        responses.response = translate('title.change.success').replace(/\$title/g, args.title);
        responses.status = true;
        this.stats.currentTitle = args.title;
      }
      this.gameOrTitleChangedManually = true;
      this.retries.getCurrentStreamData = 0;
      return responses;
    }
    return { response: '', status: false };
  }

  async sendGameFromTwitch (socket: Socket | null, game: string) {
    const url = `https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(game)}`;

    const token = oauth.botAccessToken;
    if (token === '') {
      return;
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });
      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'sendGameFromTwitch', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
    } catch (e) {
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'sendGameFromTwitch', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'sendGameFromTwitch', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      return;
    }

    if (isNull(request.data.data)) {
      if (socket) {
        socket.emit('sendGameFromTwitch', []);
      }
      return false;
    } else {
      if (socket) {
        socket.emit('sendGameFromTwitch', map(request.data.data, 'name'));
      }
      return map(request.data.data, 'name');
    }
  }

  async checkClips () {
    const token = oauth.botAccessToken;
    if (token === '') {
      return { state: false };
    }

    let notCheckedClips = (await getRepository(TwitchClips).find({ isChecked: false }));

    // remove clips which failed
    for (const clip of filter(notCheckedClips, (o) => new Date(o.shouldBeCheckedAt).getTime() < new Date().getTime())) {
      await getRepository(TwitchClips).remove(clip);
    }
    notCheckedClips = filter(notCheckedClips, (o) => new Date(o.shouldBeCheckedAt).getTime() >= new Date().getTime());
    const url = `https://api.twitch.tv/helix/clips?id=${notCheckedClips.map((o) => o.clipId).join(',')}`;

    if (notCheckedClips.length === 0) { // nothing to do
      return { state: true };
    }

    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;
    if (notEnoughAPICalls) {
      return { state: false };
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'checkClips', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });

      for (const clip of request.data.data) {
        // clip found in twitch api
        await getRepository(TwitchClips).update({ clipId: clip.id }, { isChecked: true });
      }
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'checkClips', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'checkClips', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
    }
    return { state: true };
  }

  async createClip (opts: any) {
    if (!(this.isStreamOnline)) {
      return;
    } // do nothing if stream is offline

    const isClipChecked = async function (id: string) {
      return new Promise((resolve: (value: boolean) => void) => {
        const check = async () => {
          const clip = await getRepository(TwitchClips).findOne({ clipId: id });
          if (!clip) {
            resolve(false);
          } else if (clip.isChecked) {
            resolve(true);
          } else {
            // not checked yet
            setTimeout(() => check(), 100);
          }
        };
        check();
      });
    };

    defaults(opts, { hasDelay: true });

    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/clips?broadcaster_id=${cid}`;

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 30 && this.calls.bot.refresh > Date.now() / 1000;
    if (needToWait || notEnoughAPICalls) {
      setTimeout(() => this.createClip(opts), 1000);
      return;
    }

    let request;
    try {
      request = await axios({
        method: 'post',
        url,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'POST', data: request.data, timestamp: Date.now(), call: 'createClip', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }

      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'createClip', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'createClip', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      return;
    }
    const clipId = request.data.data[0].id;
    await getRepository(TwitchClips).save({ clipId: clipId, isChecked: false, shouldBeCheckedAt: Date.now() + 120 * 1000 });
    return (await isClipChecked(clipId)) ? clipId : null;
  }

  async fetchAccountAge (id?: number | null) {
    if (id === 0 || id === null || typeof id === 'undefined') {
      return;
    }

    const url = `https://api.twitch.tv/kraken/users/${id}`;

    const token = oauth.botAccessToken;
    if (token === '') {
      return;
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Accept': 'application/vnd.twitchtv.v5+json',
          'Authorization': 'OAuth ' + token,
        },
        timeout: 20000,
      });
      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'fetchAccountAge', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
    } catch (e) {
      if (e.errno === 'ECONNRESET' || e.errno === 'ECONNREFUSED' || e.errno === 'ETIMEDOUT') {
        return;
      } // ignore ECONNRESET errors

      let logError;
      try {
        logError = e.response.data.status !== 422;
      } catch (e2) {
        logError = true;
      }

      if (logError) {
        if (e.isAxiosError) {
          error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
          ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'fetchAccountAge', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
        } else {
          error(e.stack);
          ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'fetchAccountAge', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
        }
      }
      return;
    }
    await getRepository(User).update({ userId: id }, { createdAt: new Date(request.data.created_at).getTime() });
  }

  async isFollowerUpdate (user: UserInterface | undefined) {
    if (!user || !user.userId) {
      return;
    }
    const id = user.userId;

    clearTimeout(this.timeouts['isFollowerUpdate-' + id]);

    const cid = oauth.channelId;
    const url = `https://api.twitch.tv/helix/users/follows?from_id=${id}&to_id=${cid}`;

    const token = oauth.botAccessToken;
    const needToWait = isNil(cid) || cid === '' || token === '';
    const notEnoughAPICalls = this.calls.bot.remaining <= 40 && this.calls.bot.refresh > Date.now() / 1000;
    if (needToWait || notEnoughAPICalls) {
      this.timeouts['isFollowerUpdate-' + id] = setTimeout(() => this.isFollowerUpdate(user), 1000);
      return null;
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'isFollowerUpdate', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
    } catch (e) {
      if (typeof e.response !== 'undefined' && e.response.status === 429) {
        this.calls.bot.remaining = 0;
        this.calls.bot.refresh = e.response.headers['ratelimit-reset'];
      }
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'isFollowerUpdate', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'isFollowerUpdate', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      return null;
    }

    if (request.data.total === 0) {
      // not a follower
      // if was follower, fire unfollow event
      if (user.isFollower) {
        unfollow(user.username);
        events.fire('unfollow', { username: user.username });
      }

      await getRepository(User).update({ userId: user.userId },
        {
          followedAt: user.haveFollowedAtLock ? user.followedAt : 0,
          isFollower: user.haveFollowerLock? user.isFollower : false,
          followCheckAt: Date.now(),
        });
      return { isFollower: user.isFollower, followedAt: user.followedAt };
    } else {
      // is follower
      if (!user.isFollower && new Date().getTime() - new Date(request.data.data[0].followed_at).getTime() < 60000 * 60) {
        eventlist.add({
          event: 'follow',
          userId: String(id),
          timestamp: Date.now(),
        });
        follow(user.username);
        events.fire('follow', { username: user.username, userId: id });
        alerts.trigger({
          event: 'follows',
          name: user.username,
          amount: 0,
          currency: '',
          monthsName: '',
          message: '',
          autohost: false,
        });

        triggerInterfaceOnFollow({
          username: user.username,
          userId: id,
        });
      }

      await getRepository(User).update({ userId: user.userId },
        {
          followedAt: user.haveFollowedAtLock ? user.followedAt : dayjs(request.data.data[0].followed_at).valueOf(),
          isFollower: user.haveFollowerLock? user.isFollower : true,
          followCheckAt: Date.now(),
        });
      return { isFollower: user.isFollower, followedAt: user.followedAt };
    }
  }

  async createMarker () {
    const token = oauth.botAccessToken;
    const cid = oauth.channelId;

    const url = 'https://api.twitch.tv/helix/streams/markers';
    try {
      if (token === '') {
        throw Error('missing bot accessToken');
      }
      if (cid === '') {
        throw Error('channel is not set');
      }

      const request = await axios({
        method: 'post',
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        data: {
          user_id: String(cid),
          description: 'Marked from sogeBot',
        },
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'POST', request: { data: { user_id: String(cid), description: 'Marked from sogeBot' } }, timestamp: Date.now(), call: 'createMarker', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot, data: request });
    } catch (e) {
      if (e.errno === 'ECONNRESET' || e.errno === 'ECONNREFUSED' || e.errno === 'ETIMEDOUT') {
        setTimeout(() => this.createMarker(), 1000);
        return;
      }
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'createMarker', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'createMarker', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
      ioServer?.emit('api.stats', { method: 'POST', request: { data: { user_id: String(cid), description: 'Marked from sogeBot' } }, timestamp: Date.now(), call: 'createMarker', api: 'helix', endpoint: url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
    }
  }

  async getClipById (id: string) {
    const url = `https://api.twitch.tv/helix/clips/?id=${id}`;

    const token = oauth.botAccessToken;
    if (token === '') {
      return null;
    }

    let request;
    try {
      request = await axios.get(url, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });
      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getClipById', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
      return request.data;
    } catch (e) {
      error(`${url} - ${e.message}`);
      ioServer?.emit('api.stats', { method: 'GET', timestamp: Date.now(), call: 'getClipById', api: 'helix', endpoint: url, code: `${e.status} ${get(e, 'body.message', e.statusText)}`, remaining: this.calls.bot });
      return null;
    }
  }

  async getCustomRewards() {
    const { calls, method, response, status, url, error: err } = await getCustomRewards();

    this.calls.broadcaster.remaining = calls.remaining;
    this.calls.broadcaster.refresh = calls.refresh;
    this.calls.broadcaster.limit = calls.limit;

    ioServer?.emit('api.stats', { method: method, data: response, timestamp: Date.now(), call: 'getCustomRewards', api: 'helix', endpoint: url, code: status, remaining: this.calls.broadcaster });

    if (err) {
      throw new Error(err);
    }
    return response;
  }

  async getTopClips (opts: any) {
    let url = 'https://api.twitch.tv/helix/clips?broadcaster_id=' + oauth.channelId;
    const token = oauth.botAccessToken;
    try {
      if (token === '') {
        throw Error('No broadcaster access token');
      }
      if (typeof opts === 'undefined' || !opts) {
        throw Error('Missing opts');
      }

      if (opts.period) {
        if (opts.period === 'stream') {
          url += '&' + querystring.stringify({
            started_at: (new Date(this.streamStatusChangeSince)).toISOString(),
            ended_at: (new Date()).toISOString(),
          });
        } else {
          if (!opts.days || opts.days < 0) {
            throw Error('Days cannot be < 0');
          }
          url += '&' + querystring.stringify({
            started_at: (new Date((new Date()).setDate(-opts.days))).toISOString(),
            ended_at: (new Date()).toISOString(),
          });
        }
      }
      if (opts.first) {
        url += '&first=' + opts.first;
      }

      const request = await axios.get(url, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'Client-ID': oauth.botClientId,
        },
        timeout: 20000,
      });

      // save remaining api calls
      this.calls.bot.remaining = request.headers['ratelimit-remaining'];
      this.calls.bot.refresh = request.headers['ratelimit-reset'];
      this.calls.bot.limit = request.headers['ratelimit-limit'];

      ioServer?.emit('api.stats', { method: 'GET', data: request.data, timestamp: Date.now(), call: 'getClipById', api: 'helix', endpoint: url, code: request.status, remaining: this.calls.bot });
      // get mp4 from thumbnail
      for (const c of request.data.data) {
        c.mp4 = c.thumbnail_url.replace('-preview-480x272.jpg', '.mp4');
        c.game = await this.getGameNameFromId(c.game_id);
      }
      return request.data.data;
    } catch (e) {
      if (e.isAxiosError) {
        error(`API: ${e.config.method.toUpperCase()} ${e.config.url} - ${e.response?.status ?? 0}\n${JSON.stringify(e.response?.data ?? '--nodata--', null, 4)}\n\n${e.stack}`);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getClipById', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.response.data, remaining: this.calls.bot });
      } else {
        error(e.stack);
        ioServer?.emit('api.stats', { method: e.config.method.toUpperCase(), timestamp: Date.now(), call: 'getClipById', api: 'helix', endpoint: e.config.url, code: e.response?.status ?? 'n/a', data: e.stack, remaining: this.calls.bot });
      }
    }
  }
}

export default new API();