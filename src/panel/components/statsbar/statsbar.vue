<template>
  <div class="stream-info-container container-fluid" :class="{ 'sticky-top': b_sticky }" :style="{ 'top': b_sticky ? top + 'px' : undefined }" ref="quickwindow">
    <b-toast :title="error.name" no-auto-hide visible :variant="error.type === 'error' ? 'danger' : 'info'" v-for="error of errors" :key="error.name + error.message + error.date">
      <div v-html="error.message"/>
    </b-toast>
    <b-toast :title="translate('errors.channel_is_not_set')" no-auto-hide visible variant="danger" solid v-if="!$store.state.configuration.isChannelSet">
      <div v-html="translate('errors.please_set_your_channel')"/>
    </b-toast>
    <b-toast :title="translate('errors.owner_and_broadcaster_oauth_is_not_set')" no-auto-hide visible variant="danger" solid v-if="!$store.state.configuration.isCastersSet">
      <div v-html="translate('errors.please_set_your_broadcaster_oauth_or_owners')"/>
    </b-toast>
    <b-toast :title="translate('errors.new_update_available')" no-auto-hide visible variant="info" solid v-if="update.version">
      <div v-html="translate('errors.new_bot_version_available_at').replace(/\$version/gmi, update.version)"/>
    </b-toast>
    <template v-if="!isLoaded">
      <div class="mx-auto text-center p-3 pt-4">
        <div class="spinner-grow" role="status"></div>
      </div>
    </template>
    <template v-else>
      <div class="row">
        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info" @click="saveHighlight">
          <span class="data" id="uptime" :key="timestamp">{{ getTime(uptime, false) }}</span>
          <span class="stats">&nbsp;</span>
          <h2>
            <span>{{ translate('uptime') }}</span>
            <small>{{ translate('click-to-highlight') }}</small>
          </h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info" v-on:click="toggleViewerShow">
          <span class="data">
            <template v-if="!hideStats">
              {{
                Intl.NumberFormat($store.state.configuration.lang).format(
                  isStreamOnline
                    ? currentViewers
                    : 0
                )
              }}
            </template>
            <small v-else>{{translate('hidden')}}</small>
          </span>
          <span class="stats">&nbsp;</span>
          <h2>
            <span>{{ translate('viewers') }}</span>
            <small>{{ translate('click-to-toggle-display') }}</small>
          </h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info" v-on:click="toggleViewerShow">
          <span class="data">
            <template v-if="!hideStats">
              {{
                Intl.NumberFormat($store.state.configuration.lang).format(
                  isStreamOnline
                    ? maxViewers
                    : 0
                )
              }}
            </template>
            <small v-else>{{translate('hidden')}}</small>
          </span>
          <span class="stats" v-if="!hideStats">
            <small v-if="b_showAvgDiff && isStreamOnline && maxViewers - averageStats.maxViewers !== 0"
                   :class="{
                     'text-success': maxViewers - averageStats.maxViewers > 0,
                     'stats-up': maxViewers - averageStats.maxViewers > 0,
                     'text-danger': maxViewers - averageStats.maxViewers < 0,
                     'stats-down': maxViewers - averageStats.maxViewers < 0,
                   }">
              <template v-if="maxViewers - averageStats.maxViewers !== 0">
                <fa :icon="maxViewers - averageStats.maxViewers > 0 ? 'caret-up' : 'caret-down'"/>
                <span>
                  {{
                    Intl.NumberFormat($store.state.configuration.lang, {  
                      style: b_percentage ? 'percent' : 'decimal'
                    }).format(b_percentage ? Math.abs(maxViewers - averageStats.maxViewers) / (averageStats.maxViewers || 1) : maxViewers - averageStats.maxViewers)

                  }}
                </span>
              </template>
            </small>
          </span>
          <span class="stats" v-else>&nbsp;</span>
          <h2>
            <span>{{ translate('max-viewers') }}</span>
            <small>{{ translate('click-to-toggle-display') }}</small>
          </h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info" v-on:click="toggleViewerShow">
          <span class="data">
            <template v-if="!hideStats">
              <span v-bind:title="newChatters" v-html="
                Intl.NumberFormat($store.state.configuration.lang, {  
                  notation: b_shortenNumber ? 'compact' : 'standard',
                  maximumFractionDigits: b_shortenNumber ? 1 : 0,
                }).formatToParts(isStreamOnline ? newChatters : 0).reduce(numberReducer, '')
              "/>
            </template>
            <small v-else>{{translate('hidden')}}</small>
          </span>
          <span class="stats" v-if="!hideStats">
            <small v-if="b_showAvgDiff && isStreamOnline && newChatters - averageStats.newChatters !== 0"
                   :class="{
                     'text-success': newChatters - averageStats.newChatters > 0,
                     'stats-up': newChatters - averageStats.newChatters > 0,
                     'text-danger': newChatters - averageStats.newChatters < 0,
                     'stats-down': newChatters - averageStats.newChatters < 0,
                   }">
              <template v-if="newChatters - averageStats.newChatters !== 0">
                <fa :icon="newChatters - averageStats.newChatters > 0 ? 'caret-up' : 'caret-down'"/>
                <span>
                  {{
                    Intl.NumberFormat($store.state.configuration.lang, {  
                      style: b_percentage ? 'percent' : 'decimal',
                      notation: b_shortenNumber ? 'compact' : 'standard',
                      maximumFractionDigits: b_shortenNumber && !b_percentage ? 1 : 0,
                    }).format(b_percentage ? Math.abs(newChatters - averageStats.newChatters) / (averageStats.newChatters || 1) : newChatters - averageStats.newChatters)
                  }}
                </span>
              </template>
            </small>
          </span>
          <span class="stats" v-else>&nbsp;</span>
          <h2>
            <span>{{ translate('new-chatters') }}</span>
            <small>{{ translate('click-to-toggle-display') }}</small>
          </h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <span class="data" v-bind:title="chatMessages" v-html="
            Intl.NumberFormat($store.state.configuration.lang, {  
              notation: b_shortenNumber ? 'compact' : 'standard',
              maximumFractionDigits: b_shortenNumber ? 1 : 0,
            }).formatToParts(isStreamOnline ? chatMessages : 0).reduce(numberReducer, '')
          "/>
          <span class="stats">
            <small v-if="b_showAvgDiff && isStreamOnline && chatMessages - averageStats.chatMessages !== 0"
                   :class="{
                     'text-success': chatMessages - averageStats.chatMessages > 0,
                     'stats-up': chatMessages - averageStats.chatMessages > 0,
                     'text-danger': chatMessages - averageStats.chatMessages < 0,
                     'stats-down': chatMessages - averageStats.chatMessages < 0,
                   }">
              <template v-if="chatMessages - averageStats.chatMessages !== 0">
                <fa :icon="chatMessages - averageStats.chatMessages > 0 ? 'caret-up' : 'caret-down'"/>
                <span>
                  {{
                    Intl.NumberFormat($store.state.configuration.lang, {  
                      style: b_percentage ? 'percent' : 'decimal',
                      notation: b_shortenNumber ? 'compact' : 'standard',
                      maximumFractionDigits: b_shortenNumber && !b_percentage ? 1 : 0,
                    }).format(b_percentage ? Math.abs(chatMessages - averageStats.chatMessages) / (averageStats.chatMessages || 1) : chatMessages - averageStats.chatMessages)
                  }}
                </span>
              </template>
            </small>
          </span>
          <h2>{{ translate('chat-messages') }}</h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <span class="data" v-bind:title="currentViews" v-html="
            Intl.NumberFormat($store.state.configuration.lang, {  
              notation: b_shortenNumber ? 'compact' : 'standard',
              maximumFractionDigits: b_shortenNumber ? 1 : 0,
            }).formatToParts(currentViews).reduce(numberReducer, '')
          "/>
          <span class="stats">
            <small v-if="b_showAvgDiff && isStreamOnline && currentViews - averageStats.currentViews !== 0"
                   :class="{
                     'text-success': currentViews - averageStats.currentViews > 0,
                     'stats-up': currentViews - averageStats.currentViews > 0,
                     'text-danger': currentViews - averageStats.currentViews < 0,
                     'stats-down': currentViews - averageStats.currentViews < 0,
                   }">
              <template v-if="currentViews - averageStats.currentViews !== 0">
                <fa :icon="currentViews - averageStats.currentViews > 0 ? 'caret-up' : 'caret-down'"/>
                <span>
                  {{
                    Intl.NumberFormat($store.state.configuration.lang, {  
                      style: b_percentage ? 'percent' : 'decimal',
                      notation: b_shortenNumber ? 'compact' : 'standard',
                      maximumFractionDigits: b_shortenNumber && !b_percentage ? 1 : 0,
                    }).format(b_percentage ? Math.abs(currentViews - averageStats.currentViews) / (averageStats.currentViews || 1) : currentViews - averageStats.currentViews)
                  }}
                </span>
              </template>
            </small>
          </span>
          <h2>{{ translate('views') }}</h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <span class="data" v-bind:title="currentHosts" v-html="
            Intl.NumberFormat($store.state.configuration.lang, {  
              notation: b_shortenNumber ? 'compact' : 'standard',
              maximumFractionDigits: b_shortenNumber ? 1 : 0,
            }).formatToParts(isStreamOnline ? currentHosts : 0).reduce(numberReducer, '')
          "/>
          <span class="stats">&nbsp;</span>
          <h2>{{ translate('hosts') }}</h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <span class="data" v-bind:title="currentFollowers" v-html="
            Intl.NumberFormat($store.state.configuration.lang, {  
              notation: b_shortenNumber ? 'compact' : 'standard',
              maximumFractionDigits: b_shortenNumber ? 1 : 0,
            }).formatToParts(currentFollowers).reduce(numberReducer, '')
          "/>
          <span class="stats">
            <small v-if="b_showAvgDiff && isStreamOnline && currentFollowers - averageStats.currentFollowers !== 0"
                   :class="{
                     'text-success': currentFollowers - averageStats.currentFollowers > 0,
                     'stats-up': currentFollowers - averageStats.currentFollowers > 0,
                     'text-danger': currentFollowers - averageStats.currentFollowers < 0,
                     'stats-down': currentFollowers - averageStats.currentFollowers < 0,
                   }">
              <template v-if="currentFollowers - averageStats.currentFollowers !== 0">
                <fa :icon="currentFollowers - averageStats.currentFollowers > 0 ? 'caret-up' : 'caret-down'"/>
                <span>
                  {{
                    Intl.NumberFormat($store.state.configuration.lang, {  
                      style: b_percentage ? 'percent' : 'decimal',
                      notation: b_shortenNumber ? 'compact' : 'standard',
                      maximumFractionDigits: b_shortenNumber && !b_percentage ? 1 : 0,
                    }).format(b_percentage ? Math.abs(currentFollowers - averageStats.currentFollowers) / (averageStats.currentFollowers || 1) : currentFollowers - averageStats.currentFollowers)
                  }}
                </span>
              </template>
            </small>
          </span>
          <h2>{{ translate('followers') }}</h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <template v-if="broadcasterType !== ''">
            <span class="data" v-bind:title="currentSubscribers" v-html="
              Intl.NumberFormat($store.state.configuration.lang, {  
                notation: b_shortenNumber ? 'compact' : 'standard',
                maximumFractionDigits: b_shortenNumber ? 1 : 0,
              }).formatToParts(currentSubscribers).reduce(numberReducer, '')
            "/>
            <span class="stats">
              <small v-if="b_showAvgDiff && isStreamOnline && currentSubscribers - averageStats.currentSubscribers !== 0"
                    :class="{
                      'text-success': currentSubscribers - averageStats.currentSubscribers > 0,
                      'stats-up': currentSubscribers - averageStats.currentSubscribers > 0,
                      'text-danger': currentSubscribers - averageStats.currentSubscribers < 0,
                      'stats-down': currentSubscribers - averageStats.currentSubscribers < 0,
                    }">
                <template v-if="currentSubscribers - averageStats.currentSubscribers !== 0">
                  <fa :icon="currentSubscribers - averageStats.currentSubscribers > 0 ? 'caret-up' : 'caret-down'"/>
                  <span>
                    {{
                      Intl.NumberFormat($store.state.configuration.lang, {  
                        style: b_percentage ? 'percent' : 'decimal',
                        notation: b_shortenNumber ? 'compact' : 'standard',
                        maximumFractionDigits: b_shortenNumber && !b_percentage ? 1 : 0,
                      }).format(b_percentage ? Math.abs(currentSubscribers - averageStats.currentSubscribers) / (averageStats.currentSubscribers || 1) : currentSubscribers - averageStats.currentSubscribers)
                    }}
                  </span>
                </template>
              </small>
            </span>
          </template>
          <template v-else>
            <span class="data text-muted" style="font-size:0.7rem;">{{ translate('not-affiliate-or-partner') }}</span>
          </template>
          <h2>{{ translate('subscribers') }}</h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <template v-if="broadcasterType !== ''">
            <span class="data" v-bind:title="currentBits" v-html="
              Intl.NumberFormat($store.state.configuration.lang, {  
                notation: b_shortenNumber ? 'compact' : 'standard',
                maximumFractionDigits: b_shortenNumber ? 1 : 0,
              }).formatToParts(isStreamOnline ? currentBits : 0).reduce(numberReducer, '')
            "/>
            <span class="stats">
              <small v-if="b_showAvgDiff && isStreamOnline && currentBits - averageStats.currentBits !== 0"
                    :class="{
                      'text-success': currentBits - averageStats.currentBits > 0,
                      'stats-up': currentBits - averageStats.currentBits > 0,
                      'text-danger': currentBits - averageStats.currentBits < 0,
                      'stats-down': currentBits - averageStats.currentBits < 0,
                    }">
                <template v-if="currentBits - averageStats.currentBits !== 0">
                  <fa :icon="currentBits - averageStats.currentBits > 0 ? 'caret-up' : 'caret-down'"/>
                  <span>
                    {{
                      Intl.NumberFormat($store.state.configuration.lang, {  
                        style: b_percentage ? 'percent' : 'decimal',
                        notation: b_shortenNumber ? 'compact' : 'standard',
                       maximumFractionDigits: b_shortenNumber && !b_percentage ? 1 : 0,
                      }).format(b_percentage ? Math.abs(currentBits - averageStats.currentBits) / (averageStats.currentBits || 1) : currentBits - averageStats.currentBits)
                    }}
                  </span>
                </template>
              </small>
            </span>
          </template>
          <template v-else>
            <span class="data text-muted" style="font-size:0.7rem;">{{ translate('not-affiliate-or-partner') }}</span>
          </template>
          <h2>{{ translate('bits') }}</h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <span class="data" v-html="
            Intl.NumberFormat($store.state.configuration.lang, {  
              style: 'currency',
              currency: $store.state.configuration.currency,
            }).formatToParts(isStreamOnline ? currentTips : 0).reduce(numberReducer, '')
          "/>
          <span class="stats">
            <small v-if="b_showAvgDiff && isStreamOnline && currentTips - averageStats.currentTips !== 0"
                  :class="{
                    'text-success': currentTips - averageStats.currentTips > 0,
                    'stats-up': currentTips - averageStats.currentTips > 0,
                    'text-danger': currentTips - averageStats.currentTips < 0,
                    'stats-down': currentTips - averageStats.currentTips < 0,
                  }">
                <template v-if="currentTips - averageStats.currentTips !== 0">
                  <fa :icon="currentTips - averageStats.currentTips > 0 ? 'caret-up' : 'caret-down'"/>
                  <span>
                    {{
                      Intl.NumberFormat($store.state.configuration.lang, {  
                        style: b_percentage ? 'percent' : 'currency',
                        currency: $store.state.configuration.currency,
                      }).format(b_percentage ? Math.abs(currentTips - averageStats.currentTips) / (averageStats.currentTips || 1) : currentTips - averageStats.currentTips)
                    }}
                  </span>
                </template>
            </small>
          </span>
          <h2>{{ translate('tips') }}</h2>
        </div>

        <div class="col-6 col-sm-4 col-md-4 col-lg-1 stream-info">
          <span class="data" v-html="
            [
              ...Intl.NumberFormat($store.state.configuration.lang, {  
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }).formatToParts((isStreamOnline ? currentWatched : 0) / 1000 / 60 / 60),
              { type:'', value: ' '},
              { type:'currency', value: 'h'}
            ].reduce(numberReducer, '')
          "/>
          <span class="stats">
            <small v-if="b_showAvgDiff && isStreamOnline && currentWatched - averageStats.currentWatched !== 0"
                  :class="{
                    'text-success': currentWatched - averageStats.currentWatched > 0,
                    'stats-up': currentWatched - averageStats.currentWatched > 0,
                    'text-danger': currentWatched - averageStats.currentWatched < 0,
                    'stats-down': currentWatched - averageStats.currentWatched < 0,
                  }">
              <template v-if="currentWatched - averageStats.currentWatched !== 0">
                <fa :icon="currentWatched - averageStats.currentWatched > 0 ? 'caret-up' : 'caret-down'"/>
                <span v-if="b_percentage" v-html="
                  [
                    ...Intl.NumberFormat($store.state.configuration.lang, {  
                      style: 'percent',
                    }).formatToParts(averageStats.currentWatched / currentWatched),
                  ].reduce(numberReducer, '')
                "/>
                <span v-else v-html="
                  [
                    ...Intl.NumberFormat($store.state.configuration.lang, {  
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).formatToParts((currentWatched - averageStats.currentWatched) / 1000 / 60 / 60),
                    { type:'', value: ' '},
                    { type:'', value: 'h'}
                  ].reduce(numberReducer, '')
                "/>
              </template>
            </small>
          </span>
          <h2>{{ translate('watched-time') }}</h2>
        </div>
      </div>

      <div class="row">
        <div class="col-12 col-sm-12 col-md-4 col-lg-4 stream-info" @click="showGameAndTitleDlg">
          <span class="data" v-if="game" :title="game">{{ game }}</span>
          <span  class="data" v-else>{{ translate('not-available') }}</span>
          <h2>
            <span>{{ translate('game') }}</span>
            <small>{{ translate('click-to-change') }}</small>
          </h2>
        </div>

        <div class="col-12 col-sm-12 col-md-4 col-lg-4 stream-info" @click="showGameAndTitleDlg">
          <span class="data" v-if="title" :title="rawStatus" v-html="title"></span>
          <span class="data" v-else>{{ translate('not-available') }}</span>
          <span class="data">
            <small v-for="tag of filterTags(true)" :key="tag.name"
              :class="{ 'text-muted': tag.is_auto }" :title="tag.is_auto ? 'Automatically added tag' : 'Manual tag'">
              {{ tag.name }}
            </small>
            <span v-for="tag of filterTags(false)" :key="tag.name"
              :class="{ 'text-muted': tag.is_auto }" :title="tag.is_auto ? 'Automatically added tag' : 'Manual tag'">
              {{ tag.name }}
            </span>
          </span>
          <h2>
            <span>{{ translate('title') }}</span>
            <small>{{ translate('click-to-change') }}</small>
          </h2>
        </div>

        <div class="col-12 col-sm-12 col-md-4 col-lg-4 stream-info">
          <span class="data">
            {{ currentSong }}
          </span>
          <h2>
            <span>{{ translate('currentsong') }}</span>
          </h2>
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { isNil } from 'lodash-es'

import { EventBus } from 'src/panel/helpers/event-bus';
import { getSocket } from 'src/panel/helpers/socket';
import translate from 'src/panel/helpers/translate';

import type { UIError } from 'src/bot/panel';

import { library } from '@fortawesome/fontawesome-svg-core';
import {
  faCaretDown, faCaretUp
} from '@fortawesome/free-solid-svg-icons';
library.add(faCaretDown, faCaretUp);

let interval = 0;
let UIErrorInterval = 0;
let widthOfMenuInterval = 0;

import { defineComponent, ref, onMounted, onUnmounted, computed, reactive, ComputedRef, watch } from '@vue/composition-api'
import type { Ref } from '@vue/composition-api'
import { getTime } from 'src/bot/helpers/getTime';

const highlightsSocket = getSocket('/systems/highlights');
const socket = getSocket('/');

const numberReducer = (out: string, item: any) => {
  if (['currency', 'compact'].includes(item.type)) {
    out += `<small class="text-muted">${item.value}</small>`
  } else {
    out += item.value;
  }
  return out;
};

export default defineComponent({
  setup(props, context) {
    const errors: Ref<(UIError & { date: number, type: 'error' | 'warn' })[]> = ref([]);
    const averageStats: any = reactive({});
    const hideStats = ref(localStorage.getItem('hideStats') === 'true');
    const timestamp: Ref<null | number> = ref(null);
    const uptime = ref(null);
    const currentViewers = ref(0);
    const maxViewers = ref(0);
    const chatMessages = ref(0);
    const newChatters = ref(0);
    const currentHosts = ref(0);
    const currentViews = ref(0);
    const currentBits = ref(0);
    const currentWatched = ref(0);
    const currentSubscribers = ref(0);
    const currentFollowers = ref(0);
    const currentTips = ref(0);
    const currentSong = ref(null);
    const broadcasterType = ref('');
    const tags: Ref<{ is_auto: boolean; localization_names: { [x:string]: string } }[]> = ref([]);
    const version = ref('');
    const update: {
      version: null | string;
    } = reactive({
      version: null,
    });
    const title: Ref<null | string> = ref(null);
    const game: Ref<null | string> = ref(null);
    const rawStatus = ref('');
    const cachedTitle = ref('');
    const isLoaded = ref(false);
    const top = ref('50');

    const isStreamOnline = computed(() => uptime.value !== null);
    const b_percentage = computed(() => context.root.$store.state.configuration.core.ui.percentage);
    const b_showAvgDiff = computed(() => context.root.$store.state.configuration.core.ui.showdiff);
    const b_shortenNumber: ComputedRef<boolean> = computed(() => context.root.$store.state.configuration.core.ui.shortennumbers);
    const b_sticky = computed(() => context.root.$store.state.configuration.core.ui.stickystats);

    // $refs
    const quickwindow = ref(null);

    watch(isStreamOnline, () => {
      getLatestStats();
    })

    const widthOfMenuUpdate = () => {
      top.value = (quickwindow.value as unknown as HTMLElement).getBoundingClientRect().right < 900 ? '80' : '50';
    }
    const showGameAndTitleDlg = () => EventBus.$emit('show-game_and_title_dlg');
    const loadCustomVariableValue = async (variable: string) => {
      return new Promise<string>((resolve, reject) => {
        socket.emit('custom.variable.value', variable, (err: string | null, value: string) => {
          resolve(value)
        })
      })
    };
    const generateTitle = async (current: string, raw: string) => {
      if (raw.length === 0) return current

      let variables = raw.match(/(\$_[a-zA-Z0-9_]+)/g)
      if (cachedTitle.value === current && isNil(variables)) {
        return cachedTitle.value
      }

      if (!isNil(variables)) {
        for (let variable of variables) {
          let value = await loadCustomVariableValue(variable)
          raw = raw.replace(variable, `<strong style="border-bottom: 1px dotted gray" data-toggle="tooltip" data-placement="bottom" title="${variable}">${value}</strong>`)
        }
      }
      cachedTitle.value = raw
      return raw
    };
    const saveHighlight = () => highlightsSocket.emit('highlight');
    const filterTags = (is_auto: boolean) => {
        return tags.value.filter(o => !!o.is_auto === is_auto).map((o) => {
        const key = Object.keys(o.localization_names).find(key => key.includes(context.root.$store.state.configuration.lang))
        return {
          name: o.localization_names[key || 'en-us'], is_auto: !!o.is_auto
        }
      }).sort((a, b) => {
        if ((a || { name: ''}).name < (b || { name: ''}).name)  { //sort string ascending
          return -1;
        }
        if ((a || { name: ''}).name > (b || { name: ''}).name) {
          return 1;
        }
        return 0; //default return value (no sorting)
      });
    };
    const toggleViewerShow = () => {
      hideStats.value = !hideStats.value
      localStorage.setItem('hideStats', String(hideStats.value))
    };
    const getLatestStats = () => {
      socket.emit('getLatestStats', (err: string | null, data: any) => {
        console.groupCollapsed('navbar::getLatestStats')
        if (err) {
          return console.error(err);
        }
        console.log(data);
        console.groupEnd();
        for (const key of Object.keys(data)) {
          averageStats[key] = data[key];
        }
      });
    }

    onMounted(() => {
      widthOfMenuInterval = window.setInterval(() => {
        widthOfMenuUpdate()
      }, 100)

      socket.emit('version', async (recvVersion: string) => {
        version.value = recvVersion;

        const { response } = await new Promise<{ response: Record<string, any>}>(resolve => {
          const request = new XMLHttpRequest();
          request.open('GET', 'https://api.github.com/repos/sogehige/sogebot/releases/latest', true);

          request.onload = function() {
            if (!(this.status >= 200 && this.status < 400)) {
              console.error('Error getting version from git', this.status, this.response)
            }
            resolve({ response: JSON.parse(this.response)})
          }
          request.onerror = function() {
            console.error('Connection error to github')
            resolve( { response: {} });
          };

          request.send();
        })
        let botVersion = recvVersion.replace('-SNAPSHOT', '').split('.').map(o => Number(o))
        let gitVersion = (response.tag_name as string).split('.').map(o => Number(o))
        console.debug({botVersion, gitVersion});

        let isNewer = false
        for (let index = 0; index < botVersion.length; index++) {
          if (botVersion[index] < gitVersion[index]) {
            isNewer = true
            break
          } else if (botVersion[index] === gitVersion[index]) continue
          else {
            isNewer = false
            break
          }
        }

        if (isNewer) {
          update.version = gitVersion.join('.');
        }
      })

      UIErrorInterval = window.setInterval(() => {
        socket.emit('panel::alerts', (err: string | null, data: { errors: { name: string; message: string }[], warns: { name: string; message: string }[] }) => {
          if (err) {
            return console.error(err);
          }
          for (const error of data.errors) {
            console.error(`UIError: ${error.name} ¦ ${error.message}`);
            errors.value.push({ ...error, date: Date.now(), type: 'error' });
          }
          for (const error of data.warns) {
            console.info(`UIWarn: ${error.name} ¦ ${error.message}`);
            errors.value.push({ ...error, date: Date.now(), type: 'warn' });
          }
        });
      }, 5000);
      EventBus.$on('error', (err: UIError) => {
        errors.value.push({ ...err, date: Date.now(), type: 'error' });
      })

      getLatestStats();

      socket.emit('panel::resetStatsState');
      socket.on('panel::stats', async (data: Record<string, any>) => {
        console.groupCollapsed('panel::stats')
        console.log(data)
        console.groupEnd();

        broadcasterType.value = data.broadcasterType;
        uptime.value = data.uptime;
        currentViewers.value = data.currentViewers;
        currentSubscribers.value = data.currentSubscribers;
        currentBits.value = data.currentBits;
        currentTips.value = data.currentTips;
        chatMessages.value = data.chatMessages;
        currentFollowers.value = data.currentFollowers;
        currentViews.value = data.currentViews;
        maxViewers.value = data.maxViewers;
        game.value = data.game;
        newChatters.value = data.newChatters;
        rawStatus.value = data.rawStatus;
        currentSong.value = data.currentSong;
        currentHosts.value = data.currentHosts;
        currentWatched.value = data.currentWatched;
        tags.value = data.tags;
        isLoaded.value = true
        title.value = await generateTitle(data.status, data.rawStatus);
        rawStatus.value = data.rawStatus;

        context.root.$store.commit('setCurrentGame', game.value);
        context.root.$store.commit('setCurrentTitle', title.value);
        context.root.$store.commit('setCurrentTags', tags.value);
      });

      interval = window.setInterval(() => {
        timestamp.value = Date.now()
      }, 1000);
    });
    onUnmounted(() => {
      clearInterval(widthOfMenuInterval)
      clearInterval(interval)
      clearInterval(UIErrorInterval)
    })

    return {
      errors,
      averageStats,
      hideStats,
      timestamp,
      uptime,
      currentViewers,
      maxViewers,
      chatMessages,
      newChatters,
      currentHosts,
      currentViews,
      currentBits,
      currentWatched,
      currentSubscribers,
      currentFollowers,
      currentTips,
      currentSong,
      broadcasterType,
      tags,
      version,
      update,
      title,
      game,
      rawStatus,
      cachedTitle,
      isLoaded,
      top,
      isStreamOnline,
      b_percentage,
      b_showAvgDiff,
      b_shortenNumber,
      b_sticky,
      showGameAndTitleDlg,
      saveHighlight,
      filterTags,
      toggleViewerShow,
      quickwindow,
      getTime,
      translate,
      numberReducer,
    }
  }
});
</script>

<style scoped>
@media (max-width : 576px) {
  .stream-info:first-child::before {
    border-left: 0;
  }
  .stream-info:nth-child(2n-1)::before {
    border-left: 0;
  }
}

@media (min-width : 576px) and (max-width : 992px) {
  .stream-info:first-child::before {
    border-left: 0;
  }
  .stream-info:nth-child(3n+1)::before {
    border-left: 0;
  }
}

@media (min-width : 992px){
  .stream-info:nth-child(13)::before {
    border-left: 0;
  }
}
</style>