<template>
  <div>
    <template v-if="state.loaded === $state.success">
      <div v-if="urlParam('debug')" class="debug">
        <json-viewer :value="{data}" v-if="data" boxed copyable :expand-depth="2"></json-viewer>
        <json-viewer :value="{runningAlert}" v-if="runningAlert" boxed copyable :expand-depth="2"></json-viewer>
        <json-viewer :value="{alerts}" v-if="alerts" boxed copyable :expand-depth="2"></json-viewer>
      </div>
      <div v-if="runningAlert">
        <audio ref="audio">
          <source :src="runningAlert.alert.sound">
        </audio>
        <div v-if="runningAlert.isShowing" class="center" :class="['layout-' + runningAlert.alert.layout]">
          <template v-if="!runningAlert.alert.enableAdvancedMode">
            <img :src="runningAlert.alert.image" :class="{ center: runningAlert.alert.layout === '3', [runningAlert.animation]: true }" class="slow animated"/>
            <div
              v-if="runningAlert.isShowingText"
              :class="{
                center: runningAlert.alert.layout === '3',
                [runningAlert.animationText]: true,
              }"
              :style="{'text-align': 'center'}"
              class="slow animated">
                <span :style="{
                  'font-family': runningAlert.alert.font.family,
                  'font-size': runningAlert.alert.font.size + 'px',
                  'font-weight': runningAlert.alert.font.weight,
                  'color': runningAlert.alert.font.color,
                  'text-shadow': textStrokeGenerator(runningAlert.alert.font.borderPx, runningAlert.alert.font.borderColor)
                  }">
                  <v-runtime-template :template="prepareMessageTemplate(runningAlert.alert.messageTemplate)"></v-runtime-template>
                </span>
                <div
                  v-if="
                      typeof runningAlert.alert.message !== 'undefined'
                    && typeof runningAlert.alert.message.minAmountToShow !== 'undefined'
                    && runningAlert.alert.message.minAmountToShow <= runningAlert.amount"
                  :class="{
                  }"
                  :style="{
                    'width': '30rem',
                    'text-align': 'left',
                    'flex': '1 0 0px',
                    'font-family': runningAlert.alert.message.font.family,
                    'font-size': runningAlert.alert.message.font.size + 'px',
                    'font-weight': runningAlert.alert.message.font.weight,
                    'color': runningAlert.alert.message.font.color,
                    'text-shadow': textStrokeGenerator(runningAlert.alert.message.font.borderPx, runningAlert.alert.message.font.borderColor)
                  }" v-html="withEmotes(runningAlert.message)">
                </div>
            </div>
             <!-- empty div to mitigate text area -->
            <div v-else
              :style="{
                'visibility': 'hidden',
                'font-family': runningAlert.alert.font.family,
                'font-size': runningAlert.alert.font.size + 'px',
                'font-weight': runningAlert.alert.font.weight,
                'color': runningAlert.alert.font.color,
                'text-shadow': textStrokeGenerator(runningAlert.alert.font.borderPx, runningAlert.alert.font.borderColor)
              }">
              {{runningAlert.alert.messageTemplate}}
              <div>{{ runningAlert.message }}</div>
            </div>
            <!-- empty div to mitigate text area -->
          </template>
          <v-runtime-template
            v-else
            :template="preparedAdvancedHTML">
          </v-runtime-template>
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { Vue, Component } from 'vue-property-decorator';
import JsonViewer from 'vue-json-viewer'
import io from 'socket.io-client';
import VRuntimeTemplate from 'v-runtime-template';
import { isEqual, get } from 'lodash';

require('../../../scss/letter-animations.css');
require('animate.css');

declare global {
  interface Window {
    responsiveVoice: any;
  }
}

let waitingForTTS = false;
let isTTSPlaying = false;
let cleanupAlert = false;

let alerts: Registry.Alerts.EmitData[] = [];

@Component({
  components: {
    JsonViewer,
    VRuntimeTemplate,
    'baffle': () => import('src/panel/components/baffle.vue'),
  }
})
export default class AlertsRegistryOverlays extends Vue {
  socket = io('/registries/alerts', {query: "token="+this.token});
  socketRV = io('/integrations/responsivevoice', {query: "token="+this.token});
  interval: number[] = [];
  loadedFonts: string[] = [];
  loadedCSS: string[] = [];
  responsiveAPIKey: string | null = null;

  preparedAdvancedHTML: string = '';

  state: {
    loaded: number,
  } = {
    loaded: this.$state.progress,
  }

  id: null | string = null;
  updatedAt: number = -1; // force initial load
  data: null | Registry.Alerts.Alert = null;
  defaultProfanityList: string[] = [];
  listHappyWords: string[] = [];
  emotes: Overlay.Emotes.cache[] = [];

  runningAlert: Registry.Alerts.EmitData & {
    animation: string;
    animationText: string;
    isShowingText: boolean;
    isShowing: boolean;
    soundPlayed: boolean;
    hideAt: number;
    showTextAt: number;
    showAt: number;
    alert: Registry.Alerts.CommonSettings | Registry.Alerts.Host | Registry.Alerts.Cheer | Registry.Alerts.Resub } | null = null;

  beforeDestroyed() {
    for (const interval of this.interval) {
      clearInterval(interval);
    }
  }

  withEmotes(text) {
    // checking emotes
    for (let emote of this.emotes) {
      if (get(this.runningAlert, `message.allowEmotes.${emote.type}`, false)) {
        text = text
          .replace(
            new RegExp(`[!"#$%&'()*+,-.\\/:;<=>?\\b\\s]${emote.code}[!"#$%&'()*+,-.\\/:;<=>?\\b\\s]`, 'gm'),
            ` <img src='${emote.urls[1]}' style='position: relative; top: 0.1rem;'/> `
          );
      }
    }
    return text;
  }

  isTTSPlayingFnc() {
    isTTSPlaying = typeof window.responsiveVoice !== 'undefined' && window.responsiveVoice.isPlaying();
    return isTTSPlaying
  }

  animationTextClass() {
    if (this.runningAlert && this.runningAlert.showTextAt <= Date.now()) {
      return this.runningAlert.hideAt - Date.now() <= 0
        && !isTTSPlaying
        && !waitingForTTS
        ? this.runningAlert.alert.animationOut
        : this.runningAlert.alert.animationIn;
    } else {
      return 'none';
    }
  }

  animationClass() {
    if (this.runningAlert) {
      return this.runningAlert.hideAt - Date.now() <= 0
        && !isTTSPlaying
        && !waitingForTTS
        ? this.runningAlert.alert.animationOut
        : this.runningAlert.alert.animationIn;
    } else {
      return 'none';
    }
  }

  speak(text, voice, rate, pitch, volume) {
    window.responsiveVoice.speak(text, voice, { rate, pitch, volume });
  }

  initResponsiveVoice() {
    if (typeof window.responsiveVoice === 'undefined') {
      return setTimeout(() => this.initResponsiveVoice(), 200);
    }
    window.responsiveVoice.init();
    console.debug('= ResponsiveVoice init OK')
  }

  checkResponsiveVoiceAPIKey() {
    this.socketRV.emit('get.value', 'key', (err, value) => {
      if (this.responsiveAPIKey !== value) {
        // unload if values doesn't match
        this.$unloadScript("https://code.responsivevoice.org/responsivevoice.js?key=" + this.responsiveAPIKey)
          .catch(() => {}); // skip error
        if (value.trim().length > 0) {
          this.$loadScript("https://code.responsivevoice.org/responsivevoice.js?key=" + value)
            .then(() => {
              this.responsiveAPIKey = value;
              this.initResponsiveVoice();
              setTimeout(() => this.checkResponsiveVoiceAPIKey(), 1000);
            });
        } else {
          console.debug('TTS disabled, responsiveVoice key is not set')
          this.responsiveAPIKey = value;
          setTimeout(() => this.checkResponsiveVoiceAPIKey(), 1000);
        }
      }
      setTimeout(() => this.checkResponsiveVoiceAPIKey(), 1000);
    })
  }

  mounted() {
    this.checkResponsiveVoiceAPIKey();
    this.interval.push(window.setInterval(() => {
      if (this.runningAlert) {
        this.isTTSPlayingFnc();

        this.runningAlert.animation = this.animationClass();
        this.runningAlert.animationText = this.animationTextClass();

        // cleanup alert after 5s and if responsiveVoice is done
        if (this.runningAlert.hideAt - Date.now() <= 0
          && !isTTSPlaying
          && !waitingForTTS) {
          if (!cleanupAlert) {
            // eval onEnded
            this.$nextTick(() => {
              if (this.runningAlert) {
                eval(`${this.runningAlert.alert.advancedMode.js}; onEnded()`);
              }
            })

            cleanupAlert = true;
            setTimeout(() => {
              this.runningAlert = null;
              cleanupAlert = false;
            }, 5000)
          }
          return;
        }

        if (this.runningAlert.showAt <= Date.now() && !this.runningAlert.isShowing) {
          console.debug('showing image');
          this.runningAlert.isShowing = true;
        }

        if (this.runningAlert.showTextAt <= Date.now() && !this.runningAlert.isShowingText) {
          console.debug('showing text');
          this.runningAlert.isShowingText = true;
          if (this.runningAlert.alert.tts.enabled && typeof window.responsiveVoice !== 'undefined') {
            waitingForTTS = true;
          }
        }

        if (waitingForTTS && (this.$refs.audio as HTMLMediaElement).ended) {
          this.speak(this.runningAlert.message, this.runningAlert.alert.tts.voice, this.runningAlert.alert.tts.rate, this.runningAlert.alert.tts.pitch, this.runningAlert.alert.tts.volume)
          waitingForTTS = false;
        }

        if (this.runningAlert.showAt <= Date.now() && !this.runningAlert.soundPlayed) {
          if (this.runningAlert.alert.sound.length > 0) {
            console.debug('playing audio');
            (this.$refs.audio as HTMLMediaElement).volume = this.runningAlert.alert.soundVolume / 100;
            (this.$refs.audio as HTMLMediaElement).play();
          } else {
            console.debug('skipping audio (not set)');
          }
          this.runningAlert.soundPlayed = true;
        }
      }

      if (this.runningAlert === null && alerts.length > 0) {
        const emitData = alerts.shift()
        if (emitData && this.data) {
          let possibleAlerts = this.data.alerts[emitData.event];

          // remove if autohost and autohosts are disabled for alert
          if (emitData.event === 'hosts' && emitData.autohost) {
            possibleAlerts = (possibleAlerts as Registry.Alerts.Host[]).filter(o => o.showAutoHost)
          }

          if (possibleAlerts.length > 0) {
            // search for exact variants
            const possibleAlertsWithExactAmount = possibleAlerts.filter(o => {
              return o.enabled
                  && o.variantCondition === 'exact'
                  && o.variantAmount === emitData.amount;
            });

            // search for gt-eq variants
            const possibleAlertsWithGtEqAmount = possibleAlerts.filter(o => {
              return o.enabled
                  && o.variantCondition === 'gt-eq'
                  && o.variantAmount <= emitData.amount
            });

            // search for random variants
            let possibleAlertsWithRandomCount: (Registry.Alerts.CommonSettings | Registry.Alerts.Host | Registry.Alerts.Cheer | Registry.Alerts.Resub)[] = [];
            for (const alert of possibleAlerts) {
              if (!alert.enabled) {
                continue;
              }

              if (alert.variantCondition === 'random') {
                for (let i = 0; i < alert.variantAmount; i++) {
                  possibleAlertsWithRandomCount.push(alert)
                }
              }
            }

            console.debug({possibleAlertsWithRandomCount, possibleAlertsWithExactAmount, possibleAlertsWithGtEqAmount})

            let alert;
            if (possibleAlertsWithExactAmount.length > 0) {
              alert = possibleAlertsWithExactAmount[Math.floor(Math.random() * possibleAlertsWithExactAmount.length)];
            } else if (possibleAlertsWithGtEqAmount.length > 0) {
              alert = possibleAlertsWithGtEqAmount[Math.floor(Math.random() * possibleAlertsWithGtEqAmount.length)];
            } else {
              alert = possibleAlertsWithRandomCount[Math.floor(Math.random() * possibleAlertsWithRandomCount.length)];
            }

            // advancedMode
            if (alert.enableAdvancedMode) {
              // prepare HTML
              this.preparedAdvancedHTML = alert.advancedMode.html;

              // load ref="text" class
              const refTextClassMatch = /\<div.*class="(.*?)".*ref="text"\>|\<div.*ref="text".*class="(.*?)"\>/gm.exec(this.preparedAdvancedHTML);
              let refTextClass = '';
              if (refTextClassMatch) {
                if (refTextClassMatch[1]) {
                  refTextClass = refTextClassMatch[1];
                }
                if (refTextClassMatch[2]) {
                  refTextClass = refTextClassMatch[2];
                }
              }

              // load ref="image" class
              const refImageClassMatch = /\<div.*class="(.*?)".*ref="image"\>|\<div.*ref="image".*class="(.*?)"\>/gm.exec(this.preparedAdvancedHTML);
              let refImageClass = '';
              if (refImageClassMatch) {
                if (refImageClassMatch[1]) {
                  refImageClass = refImageClassMatch[1];
                }
                if (refImageClassMatch[2]) {
                  refImageClass = refImageClassMatch[2];
                }
              }

              const messageTemplate = get(alert, 'messageTemplate', '')
                .replace(/\{name\}/g, '{name:highlight}')
                .replace(/\{amount\}/g, '{amount:highlight}')
                .replace(/\{monthsName\}/g, '{monthsName:highlight}')
                .replace(/\{currency\}/g, '{currency:highlight}')
              this.preparedAdvancedHTML =
                this.preparedAdvancedHTML
                  .replace(/\{message\}/g, emitData.message)
                  .replace(/\{messageTemplate\}/g, messageTemplate)
                  .replace(/\{name\}/g, emitData.name)
                  .replace(/\{amount\}/g, String(emitData.amount))
                  .replace(/\{monthsName\}/g, emitData.monthsName)
                  .replace(/\{currency\}/g, emitData.currency)
                  .replace(/\{name:highlight\}/g, `<v-runtime-template :template="prepareMessageTemplate('{name:highlight}')"></v-runtime-template>`)
                  .replace(/\{amount:highlight\}/g, `<v-runtime-template :template="prepareMessageTemplate('{amount:highlight}')"></v-runtime-template>`)
                  .replace(/\{monthsName:highlight\}/g, `<v-runtime-template :template="prepareMessageTemplate('{monthsName:highlight}')"></v-runtime-template>`)
                  .replace(/\{currency:highlight\}/g, `<v-runtime-template :template="prepareMessageTemplate('{currency:highlight}')"></v-runtime-template>`)
                  .replace('"wrap"', '"wrap-' + alert.uuid +'"')
                  .replace(/\<div.*class="(.*?)".*ref="text"\>|\<div.*ref="text".*class="(.*?)"\>/gm, '<div ref="text">') // we need to replace ref with class with proper ref
                  .replace('ref="text"', `
                    v-if="runningAlert.isShowingText"
                    :class="{[runningAlert.animationText]: true}"
                    class="slow animated ${refTextClass}"
                    :style="{
                      'font-family': runningAlert.alert.font.family,
                      'font-size': runningAlert.alert.font.size + 'px',
                      'font-weight': runningAlert.alert.font.weight,
                      'color': runningAlert.alert.font.color,
                      'text-align': 'center',
                      'text-shadow': textStrokeGenerator(runningAlert.alert.font.borderPx, runningAlert.alert.font.borderColor)
                    }"
                  `)
                  .replace(/\<div.*class="(.*?)".*ref="image"\>|\<div.*ref="image".*class="(.*?)"\>/gm, '<div ref="image">') // we need to replace ref with class with proper ref
                  .replace('ref="image"', `
                    v-if="runningAlert.isShowingText"
                    :class="{[runningAlert.animation]: true}"
                    class="slow animated ${refImageClass}"
                    :src="runningAlert.alert.image"
                  `);

              // load CSS
              if (!this.loadedCSS.includes(alert.uuid)) {
                console.debug('loaded custom CSS for ' + alert.uuid);
                this.loadedCSS.push(alert.uuid);
                const head = document.getElementsByTagName('head')[0]
                const style = document.createElement('style')
                style.type = 'text/css';
                const css = alert.advancedMode.css
                  .replace(/\#wrap/g, '#wrap-' + alert.uuid) // replace .wrap with only this goal wrap
                style.appendChild(document.createTextNode(css));
                head.appendChild(style);
              }

              // eval JS
              this.$nextTick(() => {
                // eval onStarted
                this.$nextTick(() => {
                  eval(`${alert.advancedMode.js}; onStarted()`);
                })
              })
            } else {
              // we need to add :highlight to name, amount, monthName, currency by default
              alert.messageTemplate = alert.messageTemplate
                .replace(/\{name\}/g, '{name:highlight}')
                .replace(/\{amount\}/g, '{amount:highlight}')
                .replace(/\{monthName\}/g, '{monthName:highlight}')
                .replace(/\{currency\}/g, '{currency:highlight}');
            }

            waitingForTTS = false;
            this.runningAlert = {
              ...emitData,
              animation: "none",
              animationText: "none",
              soundPlayed: false,
              isShowing: false,
              isShowingText: false,
              showAt: this.data.alertDelayInMs + Date.now(),
              hideAt: this.data.alertDelayInMs + Date.now() + alert.alertDurationInMs,
              showTextAt: this.data.alertDelayInMs + Date.now() + alert.alertTextDelayInMs,
              alert,
            };
          } else {
            this.runningAlert = null;
          }
        } else {
          this.runningAlert = null;
        }
      }
    }, 100));

    this.id = this.$route.params.id
    this.refreshAlert();

    this.socket.on('alert', (data: Registry.Alerts.EmitData) => {
      console.debug('Incoming alert', data);

      // checking for vulgarities
      for (let vulgar of this.defaultProfanityList) {
        if (this.data) {
          if (this.data.profanityFilterType === 'replace-with-asterisk') {
            data.message = data.message.replace(new RegExp(vulgar, 'gmi'), '***')
          } else if (this.data.profanityFilterType === 'replace-with-happy-words') {
            data.message = data.message.replace(new RegExp(vulgar, 'gmi'), this.listHappyWords[Math.floor(Math.random() * this.listHappyWords.length)])
          } else if (this.data.profanityFilterType === 'hide-messages') {
            if (data.message.search(new RegExp(vulgar, 'gmi')) >= 0) {
              console.debug('Message contain vulgarity "' + vulgar + '" and is hidden.')
              data.message = '';
            }
          } else if (this.data.profanityFilterType === 'disable-alerts') {
            if (data.message.search(new RegExp(vulgar, 'gmi')) >= 0) {
              console.debug('Message contain vulgarity "' + vulgar + '" and is alert disabled.');
              return;
            }
          }
        }
      }

      alerts.push(data)
    })
  }

  refreshAlert() {
    this.socket.emit('isAlertUpdated', { updatedAt: this.updatedAt, id: this.id }, async (isUpdated: boolean, updatedAt: number) => {
      if (isUpdated) {
        console.debug('Alert is updating')
        this.updatedAt = updatedAt;
        await new Promise((resolve) => {
          this.socket.emit('findOne', { where: { id: this.id }}, async (err, data: Registry.Alerts.Alert) => {
            if (this.runningAlert !== null) {
              return; // skip any changes if alert in progress
            }
            if (!isEqual(data, this.data)) {
              this.data = data;

              for (const [lang, isEnabled] of Object.entries(this.data.loadStandardProfanityList)) {
                if (isEnabled) {
                  let list = require('../../bot/data/vulgarities/' + lang + '.txt');
                  this.defaultProfanityList = [...this.defaultProfanityList, ...list.default.split(/\r?\n/)]

                  let listHappyWords = require('../../bot/data/happyWords/' + lang + '.txt');
                  this.listHappyWords = [...this.listHappyWords, ...listHappyWords.default.split(/\r?\n/)].filter(o => o.trim().length > 0)
                }
              }

              this.defaultProfanityList = [
                ...this.defaultProfanityList,
                ...data.customProfanityList.split(',').map(o => o.trim()),
              ].filter(o => o.trim().length > 0)

              console.debug('Profanity list', this.defaultProfanityList);
              console.debug('Happy words', this.listHappyWords);
              this.state.loaded = this.$state.success;

              const head = document.getElementsByTagName('head')[0]
              const style = document.createElement('style')
              style.type = 'text/css';
              for (const lists of Object.values(data.alerts)) {
                for (const event of lists) {
                  if (!this.loadedFonts.includes(event.font.family)) {
                    console.debug('Loading font', event.font.family)
                    this.loadedFonts.push(event.font.family)
                    const font = event.font.family.replace(/ /g, '+')
                    const css = "@import url('https://fonts.googleapis.com/css?family=" + font + "');"
                    style.appendChild(document.createTextNode(css));
                  }
                }
              }
              head.appendChild(style);

              // load emotes
              await new Promise((done) => {
                this.socket.emit('find', { collection: '_overlays.emotes.cache' }, (err, data) => {
                  this.emotes = data;
                  console.debug('= Emotes loaded')
                  done();
                })
              })

              console.debug('== alerts ready ==')
              resolve();
            }
          })
        })
      }

      setTimeout(() => this.refreshAlert(), 10000)
    })


  }

  prepareMessageTemplate(msg) {
    if (this.runningAlert !== null) {
      let name: string | string[] = this.runningAlert.name.split('').map((char, index) => {
        if (this.runningAlert !== null) {
          return `<div class="animated infinite ${this.runningAlert.alert.animationText} ${this.runningAlert.alert.animationTextOptions.speed}" style="animation-delay: ${index * 50}ms; color: ${this.runningAlert.alert.font.highlightcolor}; display: inline-block;">${char}</div>`;
        } else {
          return char;
        }
      })

      let amount: string | string[] = String(this.runningAlert.amount).split('').map((char, index) => {
        if (this.runningAlert !== null) {
          return `<div class="animated infinite ${this.runningAlert.alert.animationText} ${this.runningAlert.alert.animationTextOptions.speed}" style="animation-delay: ${index * 50}ms; color: ${this.runningAlert.alert.font.highlightcolor}; display: inline-block;">${char}</div>`;
        } else {
          return char;
        }
      })

      let currency: string | string[] = String(this.runningAlert.currency).split('').map((char, index) => {
        if (this.runningAlert !== null) {
          return `<div class="animated infinite ${this.runningAlert.alert.animationText} ${this.runningAlert.alert.animationTextOptions.speed}" style="animation-delay: ${index * 50}ms; color: ${this.runningAlert.alert.font.highlightcolor}; display: inline-block;">${char}</div>`;
        } else {
          return char;
        }
      })

      let monthsName: string | string[] = String(this.runningAlert.monthsName).split('').map((char, index) => {
        if (this.runningAlert !== null) {
          return `<div class="animated infinite ${this.runningAlert.alert.animationText} ${this.runningAlert.alert.animationTextOptions.speed}" style="animation-delay: ${index * 50}ms; color: ${this.runningAlert.alert.font.highlightcolor}; display: inline-block;">${char}</div>`;
        } else {
          return char;
        }
      })

      if (this.runningAlert.alert.animationText === 'baffle') {
        let maxTimeToDecrypt = this.runningAlert.alert.animationTextOptions.maxTimeToDecrypt
        // set maxTimeToDecrypt 0 if fading out to not reset decryption
        if (this.runningAlert.hideAt - Date.now() <= 0
          && !isTTSPlaying
          && !waitingForTTS) {
          maxTimeToDecrypt = 0;
        }
        name = `<baffle :text="this.runningAlert.name" :options="{...this.runningAlert.alert.animationTextOptions, maxTimeToDecrypt: ${maxTimeToDecrypt}}" style="color: ${this.runningAlert.alert.font.highlightcolor}"/>`
        amount = `<baffle :text="this.runningAlert.amount" :options="{...this.runningAlert.alert.animationTextOptions, maxTimeToDecrypt: ${maxTimeToDecrypt}}" style="color: ${this.runningAlert.alert.font.highlightcolor}"/>`
        currency = `<baffle :text="this.runningAlert.currency" :options="{...this.runningAlert.alert.animationTextOptions, maxTimeToDecrypt: ${maxTimeToDecrypt}}" style="color: ${this.runningAlert.alert.font.highlightcolor}"/>`
        monthsName = `<baffle :text="this.runningAlert.monthsName" :options="{...this.runningAlert.alert.animationTextOptions, maxTimeToDecrypt: ${maxTimeToDecrypt}}" style="color: ${this.runningAlert.alert.font.highlightcolor}"/>`
      } else {
        name = name.join('');
        amount = amount.join('');
        currency = currency.join('');
        monthsName = monthsName.join('');
      }
      msg = msg
        .replace(/\{name:highlight\}/g, name)
        .replace(/\{amount:highlight\}/g, amount)
        .replace(/\{currency:highlight\}/g, currency)
        .replace(/\{monthsName:highlight\}/g, monthsName)
        .replace(/\{name\}/g, this.runningAlert.name)
        .replace(/\{amount\}/g, this.runningAlert.amount)
        .replace(/\{currency\}/g, this.runningAlert.currency)
        .replace(/\{monthsName\}/g, this.runningAlert.monthsName);
    }
    return `<span>${msg}</span>`;
  }

  prepareAdvancedMode(html) {

  }

  textStrokeGenerator(radius, color) {
    if (radius === 0) return ''

    // config
    const steps = 30;
    const blur = 2;
    // generate text shadows, spread evenly around a circle
    const radianStep = steps / (Math.PI * 2);
    let cssStr = '';
    for (let r=1; r <= radius; r++) {
      for(let i=0; i < steps; i++) {
        const curRads = radianStep * i;
        const xOffset = (r * Math.sin(curRads)).toFixed(1);
        const yOffset = (r * Math.cos(curRads)).toFixed(1);
        if(i > 0 || r > 1) cssStr += ", ";
        cssStr += xOffset + "px " + yOffset + "px " + blur + "px " + color;
      }
    }
    return cssStr
  }
}
</script>

<style scoped>
  .debug {
    z-index: 9999;
    background-color: rgba(255, 255, 255, 0.5);
    position: absolute;
    color: white;
    padding: 1rem;
  }

  .center {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: max-content;
  }

  .layout-1 {
    display: flex;
    flex-direction: column;
  }
  .layout-2 {
    display: flex;
    flex-direction: column-reverse;
  }
  .layout-3 {
    display: flex;
  }
  .layout-4 {
    display: flex;
    align-items: center;
    flex-direction: row-reverse;
  }
  .layout-5 {
    display: flex;
    align-items: center;
    flex-direction: row;
  }

  img {
    max-width: max-content;
    margin-left: auto;
    margin-right: auto;
  }

  audio {
    visibility: hidden;
    position: absolute;
  }
</style>