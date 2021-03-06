'use strict';

import { error } from 'console';

import { cloneDeep, isNil } from 'lodash';
import { getRepository, LessThan } from 'typeorm';

import Core from './_interface';
import api from './api';
import { DAY, MINUTE } from './constants';
import { TwitchStats, TwitchStatsInterface } from './database/entity/twitch';
import { persistent } from './decorators';
import { onStreamStart } from './decorators/on';
import { debug } from './helpers/log';
import { adminEndpoint } from './helpers/socket';

let validStatsUntil = Date.now();
let cachedStats = {
  currentViewers: 0,
  currentBits: 0,
  currentTips: 0,
  chatMessages: 0,
  maxViewers: 0,
  currentHosts: 0,
  newChatters: 0,
  currentWatched: 0,
};

class Stats extends Core {
  @persistent()
  currentFollowers = 0;
  @persistent()
  currentViews = 0;
  @persistent()
  currentSubscribers = 0;

  showInUI = false;
  latestTimestamp = 0;

  @onStreamStart()
  async setInitialValues() {
    this.currentFollowers = api.stats.currentFollowers;
    this.currentViews = api.stats.currentViews;
    this.currentSubscribers = api.stats.currentSubscribers;
    debug('stats', JSON.stringify({ currentFollowers: this.currentFollowers, currentViews: this.currentViews, currentSubscribers: this.currentSubscribers }));
  }

  sockets() {
    adminEndpoint('/', 'getLatestStats', async function (cb) {
      try {
        if (validStatsUntil <= Date.now()) {
          validStatsUntil = Date.now() + DAY;

          // cleanup
          getRepository(TwitchStats).delete({ 'whenOnline': LessThan(Date.now() - (DAY * 31))});

          const statsFromDb = await getRepository(TwitchStats)
            .createQueryBuilder('stats')
            .offset(1)
            .limit(Number.MAX_SAFE_INTEGER)
            .where('stats.whenOnline > :whenOnline', { whenOnline: Date.now() - (DAY * 31) })
            .orderBy('stats.whenOnline', 'DESC')
            .getMany();
          const stats = {
            currentViewers: 0,
            currentSubscribers: 0,
            currentBits: 0,
            currentTips: 0,
            chatMessages: 0,
            currentFollowers: 0,
            currentViews: 0,
            maxViewers: 0,
            currentHosts: 0,
            newChatters: 0,
            currentWatched: 0,
          };
          if (statsFromDb.length > 0) {
            for (const stat of statsFromDb) {
              stats.currentViewers += _self.parseStat(stat.currentViewers);
              stats.currentBits += _self.parseStat(stat.currentBits);
              stats.currentTips += _self.parseStat(stat.currentTips);
              stats.chatMessages += _self.parseStat(stat.chatMessages);
              stats.maxViewers += _self.parseStat(stat.maxViewers);
              stats.newChatters += _self.parseStat(stat.newChatters);
              stats.currentHosts += _self.parseStat(stat.currentHosts);
              stats.currentWatched += _self.parseStat(stat.currentWatched);
            }
            stats.currentViewers = Number(Number(stats.currentViewers / statsFromDb.length).toFixed(0));
            stats.currentBits = Number(Number(stats.currentBits / statsFromDb.length).toFixed(0));
            stats.currentTips = Number(Number(stats.currentTips / statsFromDb.length).toFixed(2));
            stats.chatMessages = Number(Number(stats.chatMessages / statsFromDb.length).toFixed(0));
            stats.maxViewers = Number(Number(stats.maxViewers / statsFromDb.length).toFixed(0));
            stats.newChatters = Number(Number(stats.newChatters / statsFromDb.length).toFixed(0));
            stats.currentHosts = Number(Number(stats.currentHosts / statsFromDb.length).toFixed(0));
            stats.currentWatched = Number(Number(stats.currentWatched / statsFromDb.length).toFixed(0));
            cachedStats = cloneDeep(stats);
            cb(null, {...stats, currentFollowers: _self.currentFollowers, currentViews: _self.currentViews, currentSubscribers: _self.currentSubscribers});
          } else {
            cb(null, {});
          }
        } else {
          cb(null, {...cachedStats, currentFollowers: _self.currentFollowers, currentViews: _self.currentViews, currentSubscribers: _self.currentSubscribers});
        }
      } catch (e) {
        error(e);
        cb(e.stack, {});
      }
    });
  }

  async save(data: Required<TwitchStatsInterface> & { timestamp: number }) {
    if (data.timestamp - this.latestTimestamp >= MINUTE * 15) {
      const whenOnline = new Date(data.whenOnline).getTime();
      const statsFromDB = await getRepository(TwitchStats).findOne({'whenOnline': whenOnline});
      await getRepository(TwitchStats).save({
        currentViewers: statsFromDB ? Math.round((data.currentViewers + statsFromDB.currentViewers) / 2) : data.currentViewers,
        currentHosts: statsFromDB ? Math.round((data.currentHosts + statsFromDB.currentHosts) / 2) : data.currentHosts,
        whenOnline: statsFromDB ? statsFromDB.whenOnline : Date.now(),
        currentSubscribers: data.currentSubscribers,
        currentBits: data.currentBits,
        currentTips: data.currentTips,
        chatMessages: data.chatMessages,
        currentFollowers: data.currentFollowers,
        currentViews: data.currentViews,
        maxViewers: data.maxViewers,
        newChatters: data.newChatters,
        currentWatched: data.currentWatched,
      });

      this.latestTimestamp = data.timestamp;
    }
  }

  parseStat(value: null | string | number) {
    return parseFloat(isNil(value) || isNaN(parseFloat(String(value))) ? String(0) : String(value));
  }
}

const _self = new Stats();
export default _self;
