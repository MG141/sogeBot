import { getRepository, In, IsNull, Not } from 'typeorm';

import currency from '../currency';
import { Alert, AlertCheer, AlertCommandRedeem, AlertFollow, AlertHost, AlertInterface, AlertMedia, AlertMediaInterface, AlertRaid, AlertResub, AlertSub, AlertSubcommunitygift, AlertSubgift, AlertTip, EmitData } from '../database/entity/alert';
import { persistent } from '../decorators';
import { generateUsername } from '../helpers/generateUsername';
import { getLocalizedName } from '../helpers/getLocalized';
import { debug } from '../helpers/log';
import { app, ioServer } from '../helpers/panel';
import { adminEndpoint, publicEndpoint } from '../helpers/socket';
import { translate } from '../translate';
import Registry from './_interface';

class Alerts extends Registry {
  @persistent()
  areAlertsMuted = false;

  constructor() {
    super();
    this.addMenu({ category: 'registry', name: 'alerts', id: 'registry/alerts/list', this: null });
    const init = (retry = 0) => {
      if (retry === 10000) {
        throw new Error('Registry alert media endpoint failed.');
      } else if (!app) {
        setTimeout(() => init(retry++), 100);
      } else {
        debug('ui', 'Registry alert media endpoint OK.');
        app.get('/registry/alerts/:mediaid', async (req, res) => {
          const media = await getRepository(AlertMedia).find({ id: req.params.mediaid });
          const b64data = media.sort((a,b) => a.chunkNo - b.chunkNo).map(o => o.b64data).join('');
          if (b64data.trim().length === 0) {
            res.sendStatus(404);
          } else {
            const match = (b64data.match(/^data:\w+\/\w+;base64,/) || [ 'data:image/gif;base64,' ])[0];
            const data = Buffer.from(b64data.replace(/^data:\w+\/\w+;base64,/, ''), 'base64');
            res.writeHead(200, {
              'Content-Type': match.replace('data:', '').replace(';base64,', ''),
              'Content-Length': data.length,
            });
            res.end(data);
          }
        });
      }
    };
    init();
  }

  sockets () {
    publicEndpoint(this.nsp, 'isAlertUpdated', async ({updatedAt, id}: { updatedAt: number; id: string }, cb: (err: Error | null, isUpdated: boolean, updatedAt: number) => void) => {
      try {
        const alert = await getRepository(Alert).findOne({ id });
        if (alert) {
          cb(null, updatedAt < (alert.updatedAt || 0), alert.updatedAt || 0);
        } else {
          cb(null, false, 0);
        }
      } catch (e) {
        cb(e.stack, false, 0);
      }
    });

    adminEndpoint(this.nsp, 'alerts::areAlertsMuted', (areAlertsMuted: boolean | null, cb) => {
      if (areAlertsMuted !== null) {
        this.areAlertsMuted = areAlertsMuted;
      }
      cb(null, this.areAlertsMuted);
    });
    adminEndpoint(this.nsp, 'alerts::deleteMedia', async (id, cb) => {
      cb(
        null,
        await getRepository(AlertMedia).delete({ id: String(id) })
      );
    });
    adminEndpoint(this.nsp, 'alerts::cloneMedia', async (toClone: [string, string], cb) => {
      try {
        const { primaryId, ...item } = await getRepository(AlertMedia).findOneOrFail({ id: toClone[0] });
        cb(
          null,
          await getRepository(AlertMedia).save({
            ...item,
            id: toClone[1] })
        );
      } catch (e) {
        cb(e.stack, null);
      }
    });
    adminEndpoint(this.nsp, 'alerts::saveMedia', async (items: AlertMediaInterface, cb) => {
      try {
        const item = await getRepository(AlertMedia).save(items);
        cb(
          null,
          item,
        );
      } catch (e) {
        cb(e.stack, null);
      }
    });
    adminEndpoint(this.nsp, 'alerts::getOneMedia', async (id, cb) => {
      try {
        cb(
          null,
          await getRepository(AlertMedia).find({ id: String(id) })
        );

      } catch (e) {
        cb(e.stack, []);
      }
    });
    adminEndpoint(this.nsp, 'alerts::save', async (item, cb) => {
      try {
        cb(
          null,
          await getRepository(Alert).save(item)
        );
      } catch (e) {
        cb(e.stack, null);
      }
    });
    publicEndpoint(this.nsp, 'generic::getOne', async (id: string, cb) => {
      try {
        cb(
          null,
          await getRepository(Alert).findOne({
            where: { id },
            relations: ['rewardredeems', 'cmdredeems', 'cheers', 'follows', 'hosts', 'raids', 'resubs', 'subcommunitygifts', 'subgifts', 'subs', 'tips'],
          })
        );
      } catch (e) {
        cb(e.stack);
      }
    });
    adminEndpoint(this.nsp, 'generic::getAll', async (cb) => {
      try {
        cb(
          null,
          await getRepository(Alert).find({
            relations: ['rewardredeems', 'cmdredeems', 'cheers', 'follows', 'hosts', 'raids', 'resubs', 'subcommunitygifts', 'subgifts', 'subs', 'tips'],
          })
        );
      } catch (e) {
        cb (e, []);
      }
    });
    adminEndpoint(this.nsp, 'alerts::delete', async (item: Required<AlertInterface>, cb) => {
      try {
        await getRepository(Alert).remove(item);
        await getRepository(AlertFollow).delete({ alertId: IsNull() });
        await getRepository(AlertSub).delete({ alertId: IsNull() });
        await getRepository(AlertSubgift).delete({ alertId: IsNull() });
        await getRepository(AlertSubcommunitygift).delete({ alertId: IsNull() });
        await getRepository(AlertHost).delete({ alertId: IsNull() });
        await getRepository(AlertRaid).delete({ alertId: IsNull() });
        await getRepository(AlertTip).delete({ alertId: IsNull() });
        await getRepository(AlertCheer).delete({ alertId: IsNull() });
        await getRepository(AlertResub).delete({ alertId: IsNull() });
        await getRepository(AlertCommandRedeem).delete({ alertId: IsNull() });
        if (cb) {
          cb(null);
        }
      } catch (e) {
        cb(e.stack);
      }
    });
    adminEndpoint(this.nsp, 'clear-media', async () => {
      const alerts = await getRepository(Alert).find({
        relations: ['rewardredeems', 'cmdredeems', 'cheers', 'follows', 'hosts', 'raids', 'resubs', 'subcommunitygifts', 'subgifts', 'subs', 'tips'],
      });
      const mediaIds: string[] = [];
      for (const alert of alerts) {
        for (const event of [
          ...alert.cheers,
          ...alert.follows,
          ...alert.hosts,
          ...alert.raids,
          ...alert.resubs,
          ...alert.subgifts,
          ...alert.subcommunitygifts,
          ...alert.subs,
          ...alert.tips,
          ...alert.cmdredeems,
          ...alert.rewardredeems,
        ]) {
          mediaIds.push(event.imageId);
          mediaIds.push(event.soundId);
        }
      }
      if (mediaIds.length > 0) {
        await getRepository(AlertMedia).delete({
          id: Not(In(mediaIds)),
        });
      }
    });
    publicEndpoint(this.nsp, 'test', async (event: keyof Omit<AlertInterface, 'id' | 'updatedAt' | 'name' |'alertDelayInMs' | 'profanityFilterType' | 'loadStandardProfanityList' | 'customProfanityList'>) => {
      this.test({ event });
    });
  }

  trigger(opts: EmitData) {
    if (!this.areAlertsMuted) {
      ioServer?.of('/registries/alerts').emit('alert', opts);
    }
  }

  test(opts: { event: keyof Omit<AlertInterface, 'id' | 'updatedAt' | 'name' |'alertDelayInMs' | 'profanityFilterType' | 'loadStandardProfanityList' | 'customProfanityList'> }) {
    const amount = Math.floor(Math.random() * 1000);
    const messages = [
      'Lorem ipsum dolor sit amet, https://www.google.com',
      'Lorem ipsum dolor sit amet, consectetuer adipiscing elit. Etiam dictum tincidunt diam. Aliquam erat volutpat. Mauris tincidunt sem sed arcu. Etiam sapien elit, consequat eget, tristique non, venenatis quis, ante. Praesent id justo in neque elementum ultrices. Integer pellentesque quam vel velit. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Etiam commodo dui eget wisi. Cras pede libero, dapibus nec, pretium sit amet, tempor quis. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus.',
      'Lorem ipsum dolor sit amet, consectetuer adipiscing elit.',
      'This is some testing message :)',
      'Lorem ipsum dolor sit amet',
      '',
    ];
    const data: EmitData = {
      name: opts.event === 'cmdredeems' ? '!' + generateUsername() : generateUsername(),
      amount,
      recipient: generateUsername(),
      currency: currency.mainCurrency,
      monthsName: getLocalizedName(amount, translate('core.months')),
      event: opts.event,
      autohost: true,
      message: ['tips', 'cheers', 'resubs', 'rewardredeems'].includes(opts.event)
        ? messages[Math.floor(Math.random() * messages.length)]
        : '',
    };

    this.trigger(data);
  }
}

export default new Alerts();
