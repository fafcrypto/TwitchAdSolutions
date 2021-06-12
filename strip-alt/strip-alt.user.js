// ==UserScript==
// @name         TwitchAdSolutions (strip-alt)
// @namespace    https://github.com/pixeltris/TwitchAdSolutions
// @version      1.1
// @description  Multiple solutions for blocking Twitch ads (strip-alt)
// @updateURL    https://github.com/pixeltris/TwitchAdSolutions/raw/master/strip-alt/strip-alt.user.js
// @downloadURL  https://github.com/pixeltris/TwitchAdSolutions/raw/master/strip-alt/strip-alt.user.js
// @author       pixeltris
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function() {
    'use strict';
    var twitchMainWorker = null;
    const oldWorker = window.Worker;
    window.Worker = class Worker extends oldWorker {
        constructor(twitchBlobUrl) {
            if (twitchMainWorker) {
                super(twitchBlobUrl);
                return;
            }
            var jsURL = getWasmWorkerUrl(twitchBlobUrl);
            if (typeof jsURL !== 'string') {
                super(twitchBlobUrl);
                return;
            }
            var newBlobStr = `
                ${processM3U8.toString()}
                ${hookWorkerFetch.toString()}
                ${pushSegUrlInfo.toString()}
                AD_SIGNIFIER = 'stitched-ad';
                LIVE_SIGNIFIER = ',live';
                IsMidroll = false;
                HasAd = false;
                StreamUrlCache = [];
                hookWorkerFetch();
                importScripts('${jsURL}');
            `
            super(URL.createObjectURL(new Blob([newBlobStr])));
            twitchMainWorker = this;
            this.onmessage = function(e) {
                if (e.data.key == 'UboShowAdBanner') {
                    var adDiv = getAdDiv();
                    if (adDiv != null) {
                        adDiv.P.textContent = 'Blocking' + (e.data.isMidroll ? ' midroll' : '') + ' ads...';
                        adDiv.style.display = 'block';
                    }
                } else if (e.data.key == 'UboHideAdBanner') {
                    var adDiv = getAdDiv();
                    if (adDiv != null) {
                        adDiv.style.display = 'none';
                    }
                    if (e.data.resetPlayer) {
                        // There's some audio sync issues from the replaced segments. Resetting the player should hopefully fix this.
                        resetTwitchPlayer();
                        console.log('[strip-alt] Reset player');
                    }
                }
            }
            function getAdDiv() {
                var playerRootDiv = document.querySelector('.video-player');
                var adDiv = null;
                if (playerRootDiv != null) {
                    adDiv = playerRootDiv.querySelector('.ubo-overlay');
                    if (adDiv == null) {
                        adDiv = document.createElement('div');
                        adDiv.className = 'ubo-overlay';
                        adDiv.innerHTML = '<div class="player-ad-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 10px;"><p></p></div>';
                        adDiv.style.display = 'none';
                        adDiv.P = adDiv.querySelector('p');
                        playerRootDiv.appendChild(adDiv);
                    }
                }
                return adDiv;
            }
        }
    }
    function getWasmWorkerUrl(twitchBlobUrl) {
        var req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.send();
        return req.responseText.split("'")[1];
    }
    function pushSegUrlInfo(segUrl, isLive) {
        var segInfo = {
            expireDate: new Date(Date.now() + 120000),
            isAd: !isLive,
            url: segUrl
        };
        StreamUrlCache[segUrl] = segInfo;
        return segInfo;
    }
    async function processM3U8(url, textStr, realFetch) {
        var haveAdTags = textStr.includes(AD_SIGNIFIER);
        if (haveAdTags) {
            var dateNow = new Date();
            for (const [segUrl, segUrlInfo] of Object.entries(StreamUrlCache)) {
                if (segUrlInfo.expireDate < dateNow) {
                    delete StreamUrlCache[segUrl];
                }
            }
            // FIXME: Twitch ad banner issues. Maybe detect and remove from DOM?
            // FIXME: Sometimes freezes after midroll?
            // NOTE: Midroll might invoke player-by-picture player? Might need to change MIDROLL to PREROLL?
            IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            var lines = textStr.replace('\r', '').split('\n');
            var isLive = false;
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (line.includes('stitched-ad')) {
                    var replaceTags = ['X-TV-TWITCH-AD-URL', 'X-TV-TWITCH-AD-CLICK-TRACKING-URL'];
                    for (var j = 0; j < replaceTags.length; j++) {
                        var adTag = replaceTags[j] + '="';
                        var adTagIndex = line.indexOf(adTag);
                        var adTagEndIndex = line.indexOf('"', adTagIndex + adTag.length);
                        line = line.substring(0, adTagIndex) + adTag + 'http://twitch.tv' + line.substring(adTagEndIndex);
                    }
                    lines[i] = line;
                } else if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                    isLive = !(pushSegUrlInfo(lines[i + 1], line.includes(LIVE_SIGNIFIER))).isAd;
                } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    if ((pushSegUrlInfo(line.substring(line.indexOf(':') + 1), isLive || !IsMidroll)).isAd) {
                        console.log('[strip-alt] Removing prefetch url');// NOTE: This currently strips some legit prefetch urls (might invalidate low latency). Preroll shouldn't have a prefetch ad, assume live segment to avoid 2 second delay on stream starting.
                    }
                } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
                    isLive = false;
                }
            }
            textStr = lines.join('\n');
        }
        return textStr;
    }
    function hookWorkerFetch() {
        var realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (url.endsWith('.ts')) {
                    var segUrlInfo = StreamUrlCache[url];
                    if (segUrlInfo && segUrlInfo.isAd) {
                        url = 'data:image/png;base64,I0VYVE0zVQojRVhULVgtVkVSU0lPTjozCiNFWFQtWC1UQVJHRVREVVJBVElPTjo2CiNFWFQtWC1NRURJQS1TRVFVRU5DRToxNzY0NwojRVhULVgtVFdJVENILUVMQVBTRUQtU0VDUzozNDY2Ni4xMTcKI0VYVC1YLVRXSVRDSC1UT1RBTC1TRUNTOjM0Njk4LjExNwojRVhULVgtREFURVJBTkdFOklEPSJzb3VyY2UtMTYxMzMzODM4NiIsQ0xBU1M9InR3aXRjaC1zdHJlYW0tc291cmNlIixTVEFSVC1EQVRFPSIyMDIxLTAyLTE0VDIxOjMzOjA2LjUzNloiLEVORC1PTi1ORVhUPVlFUyxYLVRWLVRXSVRDSC1TVFJFQU0tU09VUkNFPSJsaXZlIgojRVhULVgtREFURVJBTkdFOklEPSJ0cmlnZ2VyLTE2MTMzMzgzODIiLENMQVNTPSJ0d2l0Y2gtdHJpZ2dlciIsU1RBUlQtREFURT0iMjAyMS0wMi0xNFQyMTozMzowMi43MzZaIixFTkQtT04tTkVYVD1ZRVMsWC1UVi1UV0lUQ0gtVFJJR0dFUi1VUkw9Imh0dHBzOi8vdmlkZW8td2VhdmVyLmxocjAzLmhscy50dHZudy5uZXQvdHJpZ2dlci9DdjhFZmtQT29POHBCRkxpeEhpVzVzQkh0ajF3VWR0SnhMc2RRZFlxaHZIakpvY05HaTlxeExQbEowNDNrRS03UmtaQWxUZUVWbi1mVVE1ZHJ5RVFFVVhDbTJYZWFtZk1XbHY4aDAxcDlVam1wbEpQWXNqbzRjRzRlaWJRakhBQkJTbkdfMWtCS25YdEUtc0ljZTlsZXdKSlZYdmRsN19FM2gyYmpCMVpWVU5KT29DNzFvLXpFZFRvNUszX2RQcVhKWDE5Y2lpMEZ5VnQ3dVZEaklKYzNVMGhrYmM0cGVOaDRZbEVkUVlkSWE3OTFQWDdfTGJDZmJkdWdTUXFrNXhLX2NUNlpHTE8yWDNVUU9lTDhSTWRlVkpIVllWUDVxYmQyNWZ4MzlqcWRsTTBLeEJRS1lVVk9iWmprTEtQd3RWMEpQeFFzZ0dFSVRZb2hKMm1KV29UTUktQ01rQTRPTDhpSTZZTHB1WmVneUVBeGRaUERzMUlucWFhSVpTUUlxUl9HOGZJYXZvWUVoa3BwRDNpN1NnaDhKaThaQ253d3MtZ0ZHUnRvRVhWSFZPZlZjZHEtQThmZURMNGZJNDlrS0xtSy12Tkc4VTNvU3ZQbFN2LWx5eHlxYnZNMk83blBPZDhSUFpoNUgxSmVmWDZDbENpUmNXYm95Qk9NcXZ2RGw4OERqbG1faTdXdmNHTmlXdjdKMl9tallKdlM3b0d2bUFBVlFaVFNPbUZDVDItaWtsdjZQVDdKZkpTV2h6ajY0SEV2QTVlazdvNWFweExOTy13OWpHbkR1SjJrRTBTblZoVHhXV1dVZm5GVERTYjJJcFgyWmlZMUFhUkt6NDNkYmRnbl9CYUtYR3dlRkdUVHNJOHByVzZQdjJCNE9uakZ0YVh2M1Zzd1VVVDRaVnNGM0E3VHZWM25nSDJrVVAtdFVRcTBJSzZ2YWFKeHFEaXR1c3JDeHk3bUh3ZTJYZWc0X2pPaTdfaTRMVWhKY3VJdU04VzA0WGRXWnhmb0lFVlotdnZBQUU0bDVZbTNKSm12SXhXTG1vZUd2ckVMOEs1R1Q3azhJanZSbG90OXlNeUNYTDNReVYzTWlwa0FvbVNfY2pCS0V2UjMwRGFneHFMWXl1bDZ5NHlrOGdTRWhCemRHcXkwT1ZZM0pvT1pkb2lhT3JuR2d5XzV0RFpCUDdaMjNGZF9LWSIKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MTIuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZTenBUOGtSckxTbVh6YU5fWTN4dnJnWlF3eUlyYU5WZUxJTk41X2JHNXAyTVdSTU9uOGJsWTQwV2RjT3FMeVZOMHllUFQ2WWNjcENBZEEyRjd3NGVXb081dTRlUHRqM3ZOdjJsZS1QQ0ZrNHhIOEJ6X3VKWVRkZXN4M2tITUQtVkJwc0NDdlQwdUlVc1ZPQTdJd21CNGNWSHUxY2tiRUwzU2pxaGpUS3BqYjRfME1nd3pnZ2hkYzlHRkJ3UTdJN3V0MUlPaVhNbko5RnlLUHd6bGpBV3BsSjlRS0xLeVFHalhmT1dwRG5ReGJFdk5fc3BVakhjNTRHa0t4b3p1bDJGeXVZTEwtZE1PWURUTXl2cGJua3U3NFhJZzBZcFYwLXpDMDd5OGpPTjFJT2RsZTdtbDVpbFFXTFV0MS1QZ2pmOWpBN1RlZEtPX0RsaHYwNUlJdlJueGltU3ktVTQwT0JjZ3BISUo3M3JVaDRBMjdrRjVySnk1R1RfcERjWlRjSkFESjF5N19pekMzNEpyVl9jR2FlbE0waDhSX2VBOEV3ZmRQNHI5dXNHZi13THVPaVRsdGpUY21JVHZPUWo5VE5HX2FkUTEyRUJaQk00VzVSSEtXUDUxLWRnRnRzWmtNWUMwdnVqN0FDNXlscW5Ec01RU285UlZTSklkakdpX2VHT2FuMjhkUGt0RThQM2duemlVeWZsZWdfWTlzVkxDbi1jQzBzSzBKTGN3bW5GRmxUc0xjR01vVFFtQWtLeTZDZGNsMmhLSVFUUVhKQ2FrbjVWc19aQ0JENk9CMS1UN2U5WEhadm5QR251cVo1RUNPaHRmbEI4Xzd2aXdJZHU2SDhMaGg4WkdwVzBXalhNbGltWGpxS1cyN09kWmU1Mi01RHdzNTlybEN1Mm5nUUxBRUwwNjJ0N1A3TWZUZ0NfNmlabDVicmdGRWMtZDFhamZOM2I4V2pVaGYzb1VJWTVRRld2ZDdma0J1UXVjMDJpTlZVemRWblM2Q2lLTG9sY285b3BtNy1MQWdqYWYtVkhaMDZncExGS3BUTXlEWFBWYjFuSjhqdnRKQTNmMHJvVVJacTdrMERfMkx4SkxuQXhsMWNueVZSaWp3ZXAyeDlLc0hIbTVoaEJ2RnJidThLUEF5M3czWG0tWXBiMHR2V3FtOThxM2RyYUVoQ2RsaFZJQmxIZFdCWDVxeEN3b3Rib0dndzBUNXVxUE9ZVUk1b1NSQ1kudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MTQuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0Zaa09EYUxhV2xLRGVzUU54eTlfcDZvbTNLX3BHbWlCcUd4bk8wN0JDaTItN0JEUzlnZENkYXlXeF9JTEhZaTVNWUY0eVNEaTU0RWYxWVhmLTJ2MHYxS244TXpxdll4bFVVR3R6TkJlQmNrc2w3MDJZb0xpY3VJM1l0WHVfOUV6QVdibW4xdWRfUWdMdTItRlV3WXF3NG00TUdvOHh2NUhUZjBJa1JVRk9tZFVWdjNLeUllakc0aGVtQzRoeUNPd1NhRDZZUmotdFEtRm1FSnNXQTQ3ZDZNdHExeDFuV2gyTDZBYWhJOFFVVzQ4T1ozMW9WR3FjYTQxUmZnUVNoSkMzN09XQk1oS2V1OFBQX0tDQkduUzlvaDNZOVNIQWNlYWh6anRDTk9VdFhGUnRyZEtBdV84XzAtMUh6U1h0NDJzYTBIWno2aXJkc25HVmtBTnpwY3lkMDI1UENpUWxQbHNQa2FPSVA4T0FqWXJoQlUydG5rS0tPNnQyWkFnc00yZ21KS0pGVVpab2J3Zi1qYWNXY1JNeXlHVjFQaWlvWWdPRjFvZ0hwdnUzUzE5ZThtdzFEVzQ0WkVYUUtzRWc4b2h6dUZNWEc2REJHZ3RLUzNxam0zeGJjQWFSUFFsVkoxRUp2SWRhQ1VUTGEyVjRLR3BZbUpUdkk2Q0hGcEtodnFnYWhtYUtvTDdqcmZIbzNuWENqRmVwUzBudlc2X1BPWTRFZ0xjNDJiQ3BILVVBMDNXdGxMUEFqeTNZeEVaV1hEdHZlaHRDR2k2ME5CMkNOb2hVclE5UWZfdVhYTlNWT0dMeTAwTmo4Mkh3TEh6WWJwRGZNY3I5QndrS0xVZHlTekpwbmtmVGY0VjRBaEtjb3ByU2N1cXRScUJNUFFmdnRCUGFvemd5V3NHM1BvaE1QXzJOWVdmcEdaMXBfbDA3ZXlrbUhBQXVGbTNCcWs1eEZXdFdYTmhfT0ppRXZWMzlkam1KVk5wOFl6WGRhZUxRODQ2RkQ0WTR1S2NucU9UNnhleFdYSEdaSEF3THlFVW1EVUkycWJzdWR1X0VETEJDWlFJbWNUSWtMc0d1WWtaSHRWZmJ3SkVBTEtJMFFIT2s4dTdWZ0ZFcXhROFNDLXJWZmJjbWJZZjVJalpiYTdoaGdydjNoTDRFempHRWExbnQtSDk3clRURkVoQmdMRkp0RWRVX3hzRENGMlFOVEI4Z0dneWs0OEsxX0w3aTdxYUtUbTgudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MTYuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZFTURGOUNTR21kYzNzTnRkRDR4d0NXV3hCN3NWNVptdV8waWZ2UF9SeE1rYVBYeVc5YndEcmdSclBqckpLMTc1TXBacVlMVzYxdzRxcEFYRUV0bUh4S1JJZzlzc3RIMnZxb2ZvSWo4TjM1RGxleE5SX3RHYV9XRmZuQ1hSNWhrYmQ3YTRxNjRHWk14cjBtMTYzOHdYdG9FWFlkbHN4N09YTjVVNWwyVG53NTlJOElaa0pvaF9wRHZrTDNRQVVic1Vsc1BPRWNrZzVsWVRVR2FHMnYybTZlNEhYQmo4Y05JcjQ1bEZ4T3J6VTVCeGlqZ3pUeEwwVWFhRXl0TWVyV2IzakVSaVFBZ2R4WkdUNzJ1YUt1XzU1TG9RN0w2czM3ZzNpVTF3SThITHRXWUVOVkpUU3dpRHJiRGdGOUgtb1FUZ0lEVDBiNDhpeS1ZVk05WldhZzZ4OEl1UVI4ZG5haFBMTDFMSDY2Y2xXd2Y2MXk4ZFZSZUdHbUN4X040Y1QyQnVJRmduclN0VEZ0R1M0NXZCM0dWN2RUbWpXZ3lqZFBINEZlUHVrOFZiejJ2bjJQQk8yNlRYOVpnSkZDYUJTQTFGcXFNTHh1bUdKWUZIMzZGUnV4T19FcVpCVDVWQ2xXa21Rb0pFNHFWbm9OQllTeWxGUTBQRHFoeGtLZUd3bUR1Sm94b2UwNW9jWl9YOEFDMUoyZDI3dllmamhYaHFYeWJVeEx4WXk4YVVOR1JsdEs2RDE4OVFGMjhWUGw5U3NZWDRwazE4QVBvel9uRVRWb3hEUFdkVlFtVVlPTTYtckRBR3dpbG1JN3JKUmRkdVE0M1JueXZFSEotWDN0OGlQZ0hzQlR0dUpZaE12UllucVJqVEhwekN1eDc2LTFUSTlyclhHam5nbXY0UXA0YjE5ZUJQVXc2eXVzdWVTeDVMNnY4eGlLUmZ0X3NXSDRjNWlscGJPSWhFbGxXcXhROUJWZ0k4bG9IR3ZoQkE3NzZIRTJ4U09SWklXSUdOSDRvc3VEaW9CX0FGQUEwMlFsdGxRMFUtWlgtU3JYNG45b3YtQjJsTmdWQV8xb3JVYnBCWkI4cmdDSjdmek9MTFRHVnFQckx3cHNVMEhQS3ZFbkgyd1gyRHJORTgwa3ZYbXhzNU9iRURMWGNMQzhUR2RCOHlDV1oweE1iSEVoQlRhSDNfSTM5XzdENzB0bFlGLVlPMEdneTcxUktEVEtlMk52MVNCdDAudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MTguNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0Y4cnFaTFJnRDQtNXVjQnFldW55dU01X1RHNXZOeW5qLXBwX0ZqclAtUEtHemluR1UzQjdqclFWYUhwQTBReXZYWDJ0VzQzbDZEX1hOVlVoN1BtT0l2MjVnbUF1TThheEc2RGh0WEtCR0ptUWlCbzhrZnZxeWZfbW5OYnRlYkRic1c4Zk95cEhkd3BWVHlBV2daanhqczVKaDV1ZWlkUDJOOTZxMWRuM2VRSHZ0V1R0NFE2dWlvSk1pb0FuLUNvQVMyUjR5WThScXlUYkIyMlQ2eUR0SzBHbkpnbEl1WGdKUHB3dXF6ZnRqRmxCVXhvd1VxWE5mU0FreU5zemJsMTV4eW05OExEMXBQZkFEUi1ra25fVFdzeTJtNlBjblh1LWdTQnZ0aWcwYmNGRThiSThjOC14R3REZ0dsWU93YllmandINW94NmFoV0NPSnY1NTRMT19Bc1hvcnU5cGJWLXBlSkUtbGhNMHRVQnJYU2R1eHRBWERwSmtlMzJtX3dwa3FnTDZWLVZyYmFXNS0ycFVSM19DaklCOUJYOXBqWmJKWjdDMVdNZDFPLWJ2SE1IS1psOU1aWmtEYllTVjExRS16X1VpcktxWHBSLVlnZWx5aVA2eVhuUEVlczRlblliYUNDTXFKZmpncGotNURyTkFia2xOU0Qwbm43WFR1UjN5MFpHdkVZT182QU01OTQ4NHlLSllheERKeWFfNnZhU08xc21XYzZ3R3RDdHJfLWNOLS1hczBubHlMcXktU0JnRTZhUHN3ck5qZGo4VUJYUS1iaDMtV2hJaUtnbjlXSVdiR1ZPNlVZaTVyMU9tcTcwdEVvQldoaDZzNVFhN2dBWEpaanVXZ0ZaQnlXQnhEbU00WUpWN1VBUk40MzBtX2hyUzdfTU5XQVQ3ZVpSampQTzFFOGpsMzBvZlJJZ2ZPOU5hZjJ5WUJqWlFHTmN5ZFI2YVlKN0dvYk9sa05oUEpwbk0tSTN2NEtmNmNsU1Q2Vnk5RWtmQ29PYmNBTk1NY003bE1rdmZNSElzbWV2d0FraW1jQWwzQmp5X1lhdTBWdG1pclBFc2lSQVo3LUFobnBWWkR2U0s5b1hEN21EV0hCM0s0TVVkT3RZRzZDZ2RfUHFzZEVaYWY1RXhjdnhDbU9YY3BTelp4YjRDcHlLYW9JR3p0S1RZd0VoRDQ2YWNQR3llcDhCVGRPYTVIbzc1ZUdndzdGek5XZE1DS2ZGaVBBaVkudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MjAuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZzRnVJS1dnM3RCcHc5cVVyLUplTl9FdHVuSnlSbm9nbXBrUmMzVkRyUFloS3JscXp2YnB3dlFQdy1oaWxaU1dXeHIxS2xzcjU0bWU1cUJKQzZrbEVmMG9INFRrWXROQ1FWaTBmTE1IUVg2S0l0eXdSanU1QVZXS3EyQVFYVXlwcVozRktVNG5sTjgycUk1Sk90WXh3MTgyS2lMcmhtUXFEQmE3QUl3dTVLRGw0MEtjczhaYzI0dUVZUlp6ZmMwQTJGNjVGWVBURzk2MUFvdkxJc3NTb01OSEdOZkR1S21tN1YtWGxnaUxqdXl0RXlMVW94a2lKbVh2anpzSmZHeGRnNExxRExhaFk4TzVDRl81YXlrU2xuOURCZ2t1SnpjNGdBTmRzdndRdDFNUkZUX0Eta0Z0NEZEQ2dZcmNfN0FEbzNUSy00SHAtemltVm5QUHB5S1JKQ0NFb3YwblhXckI1dFBUQ3RiUDF2ZEpiVk1EOFVNcllWekVqZnZUeVU1cWNQTDkzMzJIcFdsazdhdjhuaU80TlZuSHBsV2Rabkh2Y1JhVVdfSmZldlpMVHhWXy1YSTFyU3M3a1ppdjNBSWptWmI3ZHdRYlozUmd6b1IxNmlSME9lWDZkNU5KSWU4cjZqTUFWTk82czRzTExHbXRDYXJBYWJTLWU1bnVFMGxpMVdnWEMzZ0pxanpDZlJ2NllNQ0FXWWM4ZGdydjdhMmExZWZHd3VycVAzTndMZnRZbldncFVjRGlDNXBmMGFJdl9ITG1SS3VHOUlXWG9rcTRXMVZ1RFdTV25SWWhRaWZFZlJ1NkZZWVZzZjRoNTlvcHRPa01RUUdQdC1OVW04MGxfX2R6ZjVpOTFrNVZ0Wkp1RzJSd2RwemN5cnJPXy16UXNUX1JaQ255amhtZ1RHd3FUVVRYQmNzWXdZTmRSak9Nd2p5X2VfNHljQ1p6bVd1Zm9uY1RjUEppWnpLcG05dG1hVmE4VVozRlhVSVV2dU8wRTRxSzFiU2NVWFZoN0sxZHRtMEdYYk5aLWVyM1BSWGUxVE9QNVM2amtYbE96M01ZTDJTcWNPREI1MjhETXhkQWg2RmR0RFZjNV9oLVJveU5ON3c5UFNJNVJ5MFhQQTBpWlgwZC1XTVhnQXZHRE5pTGZvMEpHbkdrTWd2cWtBN3FHYTFQU0VoQ1BCMl9UZGRwdW1QNENDbmVVLUpxREdnd3lYNFIyVEdFaUZLbXA4MnMudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MjIuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZOa1JVNU9vWmNIS0FuaHNWS0lZWmgtUm1kSWtXT2REdGRFZ09kTk1qakZNVkhQOFlocE1IYXo0bjBkaTd4SEtqX0dycEFGMHJHSkhLbXdWSHJTaHFQbkFSYzNrbVlseVAwSjRSYkV1ckhuMjFTcEplZjc0NlhpRzhhRUpCWWp1Z3kyMng3YXBxMGRKaFVkNVVBYVRCMHpiYlpEbGptaVd6eThiXzljWGhEVGdmUk5ZY0FtNVVOY0ZZc09KeXgxX0ZvZGtPQkVGWU5NT2tteG5HU2tWV1JiV1ZvQzM0T3VvR200Q3NZbFE3emZ5dnB5YlF4Um9jby1KdnlnMTZLbDdaY2E3MmJEZmZ5aGttVm45ek8tbkE2TkZMZE1odW9BTUFPdnFNYW1McGtraGhkcE94UjJ0dGFtNEs2cWQyTjUzZFNrOWQxTkItb1pnZGlLTkYybHQtcGN3TTVGWTVwcl9uc3pTcm1lUE5CWHVsSVBGNzdmdExSMmhMaERYZlNDUng3TFNKR1VkXzgzejJFNUgtWWV5SHhHRy0yZlRKQ2xDUTY5QUdXX0U2UVhzcHV0Vm9HYXkxT3NuaUZCZm1tOXl2NGlGQUlfeFZza0J3Q1picHlCY2NxTXNrbS0zY0FVNGIyNTRTZWEyQWlPWVczOVFYMWYwMy0ydXRxTmRqV0VQcnpVVTNQbkpGdFd6MDMwYmdfLTBZcFNDOFp5M05aVW1kTWJNRmFEUlQ0dWdaX0hZcjA3UjJOYzV0dzVQdWlPdDMxb1dnMVdXMEpZVDBiOTl1dWdSZXVpQVc2MmFVbzJ6VU5BNThPb0pTUGM2WVVHUm9PMDVTeXp0TFJkMUdBRHNFVEZod0xQeDFtUlhpTU5mM2dnLXRMVjR6UGp0VmF5SWEwdHJDdEJSa0YwMjhDM2ExQnUxeEtDV25WRGhIRzJVaEo3U0JjZzI2YURnaHBPQkQ4LXU0STFPWTNzaWF5VlFHZ2U3NGE4WHJQZnVXaXJaMWtSbXRnMERGVzROSjBtdy1nM3lKbjh3RHpnUGVpVFZDRzVkbFRjUlo1ZEI2OUdiRWxzUHBlS1R1TE9Fd2FjSl9iT0FhSWQ3VE5RWkNWRXloc1lvM2JtcXo4WVE0TEpLRnJ3NUZSYUVDNXc1QTlNaFEycHNwV1NZUC1tWTlzN2dKRHJ6OEVoQTg5M2UxUXhfZ3hSR25Fc1YxenlCdkdnemN4ZGZZVnJyOTVIV2hFeXMudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MjQuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZtcUxqcXlKbW1sMXMtMTlKTElVakZpem9qWTFSRTJGWnl1cHBlM0NEV1RUMFNGdDdIaXd0dlF2UmxyYnBVbzR0TUVOdm0tYk1iS2dYMi14OERHUFBQS2RWMmpXUk44Y3BfakExcDR6UHlMSnBXMmYxaTlxQVNJMEFvXzVRUWVZVHdqbEhTYkx6ck4yNFhsVmxaQUhiYTRUVzR1ZEdNY2Rqa2Zud2hqUW1kUmY4elZaWHUyeTNFOWNTM1Qwd3RvVTZNOHJ6bWp3VVJsOW1pT28wWC15WlhNeGhubUFXM0xrTlZ4Z3I2cUxHTndSMGFYbU5WVWsyVnlJUzdHby1MZ2RxdkcxWjl0TmE2MlJJYk1WVW01aWRZZUg4eWdjRk0wdTVnbDJMWlFMX19hQUVTYzRURG1DSm05anhsVmtyRHBWbjJYbjgtdzBWcFNGUEcyczViM0QwQTRkcHZWQVY4ZnJmeXFTUE5sQUpJWmlqZ19sZzRtWS1Qa0k3UDI4SmdsUkRTNkpaZ1JYRDNDWjhMc0tUNHRKTk1JTzRBY1JhX25wdlhMd1h1dGJMU19RZ2FBNnl3Sl9wTDdjX29yQnQyVG1UQmIxaEptX0VUMG9yMGJ0ZW8wUmRlNm9CNFFmMUlyTkd5cjhWX3d4bHc5cnFSWFVwa3BkR0lzMXZDOVpSZGRycC1MX3hCTWxBMmJlVVNBSWRqNlhLaHdHbHBKNHJiRDRvcEhnN283cHNkOEl3MklqbUlYU3FqQzNlMk5ZU2FuQ3VXQmRzYUs3QnFLby00RV9mZFVrRmVkbU9GSDV6RFAybW5teEdyUUIzRW1TVTFaR1JiSHNHQnZ5eWNLSmVHeTd4YVZ5ZDdsM2hnUy1rQzdHaG9UQ01ITW9DWm9OcnpYdWowdmRUbGpDOGdwMkFLVE9kV25PQWhsaE1aRGFXcHQ3WnN0aGlfUnB0WjNEbWdOLVdvOWJPMU4xWl9mcTNqNk52eUc2MWh4b1dVQXc0RTd2ZVBha1QzZHZJX0Y1MTUtcGQzejRwQk5vSGlmMlFpYWoyQzlPdHZOQXJpYy1mZ3VrSnJ2SGo4S29aS1o5NnVHRGc1M0pWTVVwWXlwVThHRXNZZ1BoMjJ4eUUtQmNpckNDSk40VTRkTkxYSnBTR3BsTlZ2ZXY4MnMtNWx4VTY4WDJudldSWkVoQmFla0c3b0xSbl9tenhaM3hHZTNHY0dnd0t0U3lUSDZkeHNla0tVRzgudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MjYuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZNZWhXcXVjRVJVMHptQjA2Tkhvbk1CemxVbkd2MzNtN2tiNjRrQ1JKUmhxNTl6ZFVDQTNqc05IMGs3MlNDcC1oVjN0enI1OVZhMDJEUE9vdmlGQk1DcGk3aVRTUjMwSkM5eUVzUjVsNG5BdllFQ3ctVzF0QldWdlJnYTBGOUlRZ1Y4LVRwczltSEoyOXoza0d1U2ZfRDZBa0liaVJfNlRIQmRKZHhKeGpvaVBSaEJUSkpReXM0UXhGbjJpeU1DWlVVSmtVMkNYdHNYUkQ2aWwwb00yeXJ1dF9Ec3J5bmRSUUdVQVU5QlZzSURMTkxvUWtRZkFfUG5hMEJzeEFFY3JjWTZoWnRISmhOeGFPWHFkczdyb2lEWF9BQlhxQjJteWU1MVgxQXl1VEZydDRpeFFXY2ZSaTVuaHA0VjNaaDRvTTZ5aTh3R3VvUXYxbjRyMFhUd3FiX1FyVUtiNUJWRVJxek5EV04wZTZWMkFSOVI4VHlDczlmQXh0dEZ0Z3gzY3lhM0FJeEFFcUhqcEUweGY5dUFTdzVQbkV5MEUwWEgyNzRFS2ZnVW1VVTMyY1dxOW9PNWphbl9ENG9pdzQ3ekZEQXA1NTFWcllJVXRjY0FNMGFLUnF5SGo4TDhYeXV6V1B4SmZMM1lUVWl0dzRfZ01qWXAtUUNqYXRneVgyZHNNSjExUzQtc01obW5HS2hlSnpJZEJ4U0J1bzJSc09SbmR3ZUVSMEllNFc4c09oeEFIRXRZM1ZBMVVWdzlIREFhSVRWWEd2cXFFRW9lN1REY3k3d0VzdHBybWR5MllSRzlQZzltVjl0UGR0R0p3WHBabnctbFl0NFVBQUJNUjBWZ3NhUjk2UTRqYzlQb01uZ2ZfWE5kN196amxwa3RoekptY1FfZG9mOUxLRjBUdERINDAyZ1JoTzFKaUJiR1I3LUM0SW9QUGNUdy1NMW01TGF6VkdHWjlHX1VfUTVoSVg3VTJMY183N2Q5TXNTYXduR3A2MjlRU3ZTMkFjdmw0ZE5sTUpJeGl5X3Q0clJsTU50NFprejlESlJfbVBMX0J3QkZsMEd1UTByQkxsZXR2SWl1eEZ3NGNlYVVIaWFDdzZaMGJGN21oQXU3TVZoWnQyT1NMN3M1SmJCOXhPSFZJdVRxQnJJbl83SGpGYjBHNy1uQk5PcGNFMkVoRFFFQ1VJVzFXX180cXFsYUNYRTc4eEdneWNIZUNSOFlCR1VFQjJBSmcudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MjguNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0YwdnJBXzJOdzBMejNWV2h5S3QwVVd5ZmtxUE1JVUh2X0FNUDRfV1lnMXNtdWJ1U1JGTlV1eFZzX2dqTnZYVi12d3lRa0lpVEl2dGluSlN4V1kxQWZYQ3E1RkpzWnhpTkV2Q3F4ekNicXpVbktzSU9oNXZmNXZuRno1ekhmN2JGNGJnbHA4WHJEQTRQNTZvV3VOY1NfNDlhZ0lHWW9sT1NCQjFkX2JJN09sT3V5SDVaN2l4N1ozXzdVeHJYQTVXUjc3ZVpfVW04SV9MbE11UWs4RWNtX2w4UzFUMzlmS3haNHkzMUZDOU9xUTBDampITndieXVkX2xVNldRa3NoUktCaHBxNjNMY2ZsMkxuQzkyMmhGVExDb0tIMlNvTnJBMHNTQ3dGWU16S1RKY0U0ck1YN1NRSEt4RDJ4X2M1VkdSWmk2Sk1hMVJ4Q2M4UURsaWVzZTlHRFNCZll3VjladzVlRWFub0lpNnZiVHlEV3FGNWEyUHpCX2NzREZCdVljaU5MS1dONElKd3ZRZUU1Mk4yY2hoUGlyYzJ3b2hyZjBwdzA0STI4MUdtd2xrR3doYmVnLWhDV3RVTWhwcFFWUHI2NWN2QmpuSzRVVm9vTmx5djdCSFpOdUJrXzJTREM2cmdTVHlDZnp1OFdTMG1Rd0NDX1BEMWxlbm5TZ0p3aGc5Ml9ObDlmb2tkV3E1em5BMEM5WGpEcXZjR0VtNWd5YXJlTkk3cEZTb2F2VW5lZkEtYU80SjJMVWs0dUVtVTVNbEtfR2FZcFhad3A1cU1ELWdHWTI5Mk93Ylpzb0x4SVpaREdSVzVsM25YY0ZFNXZzWk10RW55NTlYQVUxTkxMQVMycVFkYWpYbXFoUFY0d2lndEYxdEMwaDItZHhyb3Y2aDExLU5teHFjRmNvaElMNXN0QXdkZmdpcFB4NS00Y1BPcW9SVjZHY1M3c0RLQ1BUTDlaUEowZElHUHhzSTN5ZThVOUcxZUNlUnN3OC13TGl5aDM0dzhUMmQ3aHZ3UkhRZFBQalFEZWVHRkpMeHdxRHh3RDBQNzE4MHVkRnlJaXU1MXJzdWdfTjdfRGl2cHpMb0U5QzFrY1dVcnhra2dmTEFiLTUweUhYUm5QRl83eVZsOV9fdmNjX015NXpsUEVHYlpiMWRLZkxGWk1GX2k4ZUNlS3FtOEVoQXFSdm9fSWNWZG53V015c3pMNmNTdUdneWxyVVdQZHU4T2RfdC1tNEUudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MzAuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0Z5anRXVTZpcFdtMkNiZ21SNlRsdU04WG9QMllrWXNlUUNLdVdjQXljMnkzS0RneFBUN0pOTU9mdUJzS3NNcFQyRHdDbnNNTlJYTnZxTXBuRDQ4eGU4SjdZWTF6MndtSjBCTnVuNk8tZHRycEtsaF9RelRkQl9lajFaZnlJSXBHa2hNVUhhX1ozbFlzZldEanZGYm45a3BSQVVwMDlxX25uZm02QUpSeDh0NHRfWFM0TkcxZWl1MEMtSm5MX2lKanNPNS1Kb3BZU1Y3Nk5peXBEbTd0U2RiWHNMNWdIOGFwRGtjSzgtUC1pbEdnWkw2ZEF5dlpxRHBPTEpZMEVqWnhWeW9zNm1KdFZ4NXdCdHFJdDk4Z01rdFVMdThiQXpISFdNVkRzYVpzVGV1ejNEdEVLSnpNZmJpZXI2VnQ2eERHOUZnalNaVlFKLUFjR2RmUUR0bnV0RUNjVlE0ekJLMXN4U0VNQ0Z1UmVCekp0Xy1DLWhEYlpYc0hGN3NUT0I4dlpkTlN0OVNGbmNrNWEyNEJtd20yUDBsRWZRTDFFTUhubmRuN0UxVFg0OU0wTE1kaTdBanlWSHR3SkpldHQ5M1BZbC13dkNtaXVBNHVqdXoxZXBjWmhJRG9IdHhJRUdoVFNvMmxQQklBUl9wUDM0QkpBeUV5YkVzRUVBU3FlRXVacThXanVmcmRiblBISzZEXzRHS1RzSmJqTlV5ci1HOE1udlItU29EZnhzcDluMXNTeGRVUWZSR1NGc2lNN1J3dU5UMHJYZFd4Tnk0blc2TkxBcGYtQlZFMUxuMEx3VzJIenYyQWNFWDFZeEdMQmYwRHdtWnRxNDVZdmEwU1pCc29EVnJVeHoxV2xhTk14emFpUW9oVXVpazJBVldxTWcxVkI4MDVnNTU2Uy1mYmllZXR2WlFHa0dsRFZzMmxwbUZaWjF1TktPU1JMZTlYR2txQm90TmZmY0V4eThhTUJNOGE2aTFQMF9jTEFzZ1l2Wkt4WUQ3cWRFbHZ1aXdTc1duLWRwUjE1cjFuZkI4cWxUcmpXVk43NUNMa3g2MUZYelVKREhHb3FaTS1xZDQzZ3VBVGY5N2dKTEs4QnY2ai1aWU51Y05NYlVabWlQdGxZU1p0Z0ZPNmFWRzhUOC02OGJZSFh4dHRHc1NHaDhyYndWcmx2S0VHR0VoQk05TDZVQ3B6dE5QenExeTlZWDhWekdneTZReDN4LXNBVUNuQnptd3MudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MzIuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZkQ1Flc0ZNYi0xQVZfdzBSSl92TjlJRXJrclYtMWprb0NQSTJMZkNJT1RrcEl6dFlaTWhvWXdxQllKUGpkcGwxVjhRalFQMVZoUE9YV0FuZF9fT2c5bXlCUW5QcjNEbEJ6Sy1GVHk1SGtoX0dQQjUta0IwNkxoZmF6bjhDT1RqY3cwbWEycEVOeVdCMWpUQ2poS1FBa0RFODlvWWlZcEt1NFhESVR1QTloQXY5MDJUdVhSMWFST2E3M3V1ZHkzNjRxZjR2Y0o0WF9FSHItZTFSSFUwUFctdXFUX2JlRXdGNEdoajZWblZxbE5USGhCcGRRMDdwZ0hiMEFoQkhMd2toRm12MTFqZ1U2cEU0Qmo4YkJEVDZ4bTRQMVhuOFhJWlg3blYyd2lYNy15anp4b0ViejRaUUtpeG9KVEhzOVFtOE82RkFSdVRQelJTaHhkZnJpbXhtNDlzYXlaNzluM1pjMnlQVXpZN1c5Y1NNYXVHR3A1b3lOdXpFbGNVWTJ1QVdqdDVyOFJBRlVIZndGVFp3ZjhCQ240ZWJuVTFTLV83b3BXakpRbngtOXhOYXRLcjZoX3dSYUt0aDlKOHZuOV9LOHktTk13aXpaQU9OS3lVMFIxMGpaLWhOazdwTlRxVEZYejBadXY2SVN4S0lDbTVLUUZLMHVScmFLWGY0RTlvZ3Z1Z25wWVFPbEp5MDdXblFsQjBxQlNIZGVKY2wzei0wSTU1R2c1Y0ExMTl4NkJpM3hVT0lRRURNbFlPWmJHanlPM1FtcGhab1JYUEVYaFRVUUFxeU5FQURfOG9sNjZuRlA1dkhpX0dRaHNwc0FjbUJiVGczZGdKLVpVZ290c2ktQmJoNHljTUpWckJpS2VkdDV2N2t3RmUxSWZKel9WS2IzVTQyc0tRd1laTEZ3MGNsUzhoS1hYX2ZIRUVabXVIRzE1TGR1c01GM1p1YTZpQm9wT2djQUtTcFRiX1A1WWpVekJfekVxQUVHdzl1Vkh3UTBqa2tSa3YtMlBnZk9EV0FDcU9fVkFZc3Uwa1RvbEt3TEdaVEE2YWxkbUxpeGtkTkdGV2h6bGhaT2NXb2tRVHE5QVNwUk5hQ21sdkdZVWtMaGpPWWk3TGt6V0tfWkxzUnpwZVk0WWxyczFvMHF3QzhtSTFZZHdtbi1iODMybUVucmNkbkVoQ0NGTzYyRWtTVDIxWVJWdE9heDg2eUdneUhPNW1HdE85NjNfMDROcGcudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MzQuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0ZIV1FHaHZNQ2Y0QXlkRDN2QWZnWkFFTmgzRm1CWWhQa3ZIN0ktLVBCaXVUZnp1cnB6cG1NaXY3Ym9RdXpxQjJzbFFyZk9ESzNiMnVYZVA0N3YxWWpVdnBMNV9XZXdadlZlLUpoQUY3TjhDcjJ0Vi1ZVG03elRma1FSRVVGeFVMLUU0RHUyVk9tcjB5OWhINkRlSGpiME55MGJ6OFhiTWN4Uk9GMW03S1BJN2oybTE3anlmV0VkRV9oNnBPbjUyWXZvYVZIRzVrSGNDc0lxTmltZVN6Q0NCOHZLYkd4ZFFrUEF4dzlkRzQ0QklzcWYwWnVYYXJKbm5iMTNVblp6TG1pdlZxRF9hVWo3dDM1aG9seE9zSHI3QVg2VzQ5aGk4REVQYzllaVd4a016S3F2aEhMTXNBNVBCcU1VaS1VS0N0Z3M4STdWTVdkRDBlUnMyOEl4WHFQOFRqVmVzQkdrSkZ0N1M3TGc4NTNpczRlNjhaOVNRZWhUMS00V2dLejR5dEhzTElwYXdDU0lqV3RGa3o0NXRiMHowLVpHVFoxdDJUU1lWN3hQUmlwWUhKWEFHN3ZVcFd1OGRfa3BkTm5hUW1FYzZFdjBwbjBhSDdYVFdtbEpQek9MMGJCVHJ0Nm5yUko3N0h3SDVoOW14b0x4UHNQN0hRRXN4cWNDUGNvY2RjcWxYWkhMUzlYaHpobmEwSDFHclJvb0dCbWNRcENELTdYeHdCSlBpN3FicVVlR2RMMFpzanFGRmp0bVEwd2FSN3VhSTBBX0ZsdlA2eDdwdnZnWjh1c2JCZFpmNlZXXy04QkpsbWp1MURVN29UNEo0bmtxME53M0xBaDJ0b0treXlrVUlFWFlSZWlxTVp1SzV6UzZZaW9wTWJKOWdtSE45VnQtVGpfZmx5ZWFWN3diR20tNGx3TjdSY3ZMQjNISnp2X3dyYVhEWlVKdXN2UHlUc3hFcHh3RkRCTUxYcnEzVm5kS1A0SFY3Q3NtaWpobTRXYjRNTEFqajMtVnd4YzZ0Z05OVGVOTlhPNVltUHpQNV9rNGRqRFZ0MHNKNkZrT1VPbWtLcmFQamctaDF0QzJxTkQ1czBsZFhvVDNZYjJMZ3EyWWVHcE5XclRWWmpyNHpwaTYzS3NrR2NvZ1BVRUNNSi1Cd1ZtMTlGQ3E0MElIMnVvTkZKaUVoQWdQUkl4cFF2QUZGNFdndVB4WTBvakdneUpFTC1FSHYyN1czX3EtY0UudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MzYuNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0Y0eFl2UGxCRUUxTHNwVVF6aGlWQlhGM2NfMlVkSE5CX3cxdEg1blNiTEIxWWswZmx2eVFwMDU1WWhGdFpVM3g5M3ZBU3NXTUV1WlFvRkFrWGF2NEZlNXdNWTYtYkNBOTlqRXFCOGJRcm9RUERuWXJtbGtvYkFwbGh4Z0IxQ1BIcjZDSzlxSV9Pb0hXVlM0STJ1NmdlRERrV1R2ekdWSlM0QXE2MlR5SXM0bm9xNFJ3Q0xWb2JvY3gtS3VtMVdOcmVFT2J0NHdSdUIwV0ZneFNQNjRNaG5DSGlVcnlMRnMtekJYbHRpc0EzMmFhckFYSlhadU5idGNzcHNoelhoQ1JJN1poSWZSbm14cUVuTXY5cWYtM1pqZnY3OHFjcTA1dTJ0ZzFxcVNkMG9sSnc0c1puT08zaV8ySVZjTEFKUDA5RnNPZmd6SFBBTXJRMXdrbGw4OFVsUnduSGlTMEw2SFlhZ1hOOHlSUzdZQ3pMRjRtMVVHMW1qZ3M3TmNsRm1xVGJUTTYtSGpKSGlzMmZQWUg4YTctTER1WXJFdHBGcDdxcmZDZ1NVc2p5QjM1NkEzMHc2c2l5eEctQVN1S2hiSWJjaXA3UEN0ZGxQenBjeFdQZGxCeEwzRnN5cHR3d3k0NWd1OE15dzJnQUJuTmxhUWdheE50ZUhIbkZWaDR5UjZtZG9jZzFmNTgxVWY4YUk1dGo0Sk5aZ0dIQ0Q2aERFejJGZU1LLXJwQUxDLUhwRzZiVHYyYkRfSlpkRi1XZUZhS3ZyRGh4b2hDbzJuYlY3ZXZLOGsxTkpocVhvRmtlcVRCSklWeFFTRjdqano2alhWcmZwRERmazRhOEcyYTVTelg5cGtEMmdlXzg3UG5WbWdZQWVTa1R6TGFSdVdzNjNmYTQ3OG4xUUpVQ1lvR2h4SjVRSzFxclF4YzdiNE5EZW5oZjJaSDI5blZKVmRBRFZsd1lZcWlWalJHVFFGeWxES2tUOWsyampkZlc1LTVZSGlKS1oyRHZ0Yk8zZm5qU2FHY3ozTTRKd1ppTFBQSUFibEtUaWZnOU1QaTFnYUZra1ZyZFhFeGtUNjNxNTdROHNZOW9JR3VOSVpHMGpBNmc0ODNvTDRpT1lTRDVnbGMwNUkyU3hBWUpDUG95dmdKczYzVlhkVjBfWjg2N3I0N3ZlbXFUNmNUaEVoQV96UmlhUmtJMHp3Q0E5NjF6ZXI3RkdneXNFTlhIcHlCdkVnLVpaTVEudHMKI0VYVC1YLVBST0dSQU0tREFURS1USU1FOjIwMjEtMDItMTRUMjE6MzM6MzguNTM2WgojRVhUSU5GOjIuMDAwLGxpdmUKaHR0cHM6Ly92aWRlby1lZGdlLWM2ODg0Yy5saHIwMy5hYnMuaGxzLnR0dm53Lm5ldC92MS9zZWdtZW50L0NwY0Z3ZlI1NDd3TWk5SXJtWmI2UjJpS21SWnExWDQ1VUZNSnNHU0Q3bmZma3FmN2ltYjAtdnUxcjJ0djdfeFY4QnNBcUxMMnRkdVpHak1HbDNzSk4wWVhWQ2ZfQkcyWWIxU2NXaUpfOWttN0FTS0pSLUhwTzUyR2NQaFRYX1NLRG9ZY243OW5QWG5wWEtIdkhsSW1BZFVLWTNjdXkzRlpDeHJ2R0lkQTM1TmwwaVhwVjFqLTRQQmN1ZVJYYkZ5Z0YwZWY0LUVKZWdyY2Q5bzhSeUN4WXRzeDJ5NWRIR3l2blJ0VGE4M01VaEpnSklFbmd1SFVKS014NDFjSzVXV2pLbW10QXhMS2tSc3VYeGxCN0lQVWdOaE9qRWFORzFjeDRGY01MT2p2b0FpSDM4cHZWOHhEMTU4cHhuVVNQWjk3VnlkX1BmaGRZNjZxS19MTjR3VU5xYW9HS1pvRG96TWprSHVzN3NSYjFLNUxXUEZxVndSOWU4eTdmdnN0M2tjNjljTS1aNkt2NGU2SnZsSjQ4OWJTZXhKUUplN0FTUjRYNkR1YjhUTHpkTGN0VVBuMEFuUjE5MzMyMUJxV0NkLXV1c2wwVVdYMUdyZ2k2ampMdFp1ZkdESHVvY0J6YVFrX1FFV3hhRnBpb2twdUJaWjlHWC1XbkVRVkl2cVFGZXlUdjRRbjlJR0RCSkgzd3hXTEZPMUl5MDU1N0xQLXEyUUJqQldyTVQ3WVlmbWZyQ0tZOGdxQ2dBY2VFb2g1V2NsUVBxc2hubFg3X0JrVUhSbzVJVDJ0OXZFd3ByNnpzT04zNl9XSjl4YmpNYy1rdTh0VlhvMmlDN0Rscy1fYkk2NHF1XzVOUGhELUtCaDlyLWJ6X3Z4LWtuSkwtTndYeHZidWJUTGplY2RkTmlib1U5a3FBVDU3R2xZTm83RnA1UVBVRkFvYW5OVXdGaGgxdUI5TDlDcURUUWFRZF9nejhuLWswMmhPNHh3Wno2LWl1aVNaMFVlb1F3WDA4MGlrdTZGVUZFVEdBUjNKVjdibDlLbl9hMmFKRmdUX292b0k0NmFoRWFwbkJpZUdqVEJpbnA1MGQ0WnZVa3VrTmg3bUJSZ093ejdyUEEwdUwzczJVbEpNTW9NV09VaDliRnZnN2tlYWVpeGZGRC1VWi1BUmlUYWlVM3N4TlBNM0VoQm5ZYmdfRGZsUDhkVnhCdnRpcl9GX0dneTl4a25RWVBzSERRUFc3STAudHMKI0VYVC1YLVRXSVRDSC1QUkVGRVRDSDpodHRwczovL3ZpZGVvLWVkZ2UtYzY4ODRjLmxocjAzLmFicy5obHMudHR2bncubmV0L3YxL3NlZ21lbnQvQ3BjRnNsaExtamd1OFo1R2RfUnpJMG1nSllLWHBLVmpXd250VEFWM1dDN0xFVldKeFFUZ1NBdVdNc0ZaRXVHb01XQmdCbFZMdUg0TlhEUzVWb1ZibWFwbkpQS2JjSTdSbThaZUFuV0lGNndDcVFuQmowMkZfcWZ1MUFEd3ZKVmw2YTYzRDhIVU93RjZ2QzdYRTBVMXpLZVdQanVIdUItU3IybDFqMl9FcnVKa2xVLUh1TGhQNTM5a19GaUFvTkRFVXVRdGtNalQtTDBUeUlHdmdTZFBldHNPdDRWT1Q3eHZTNjFCaHBHa2NrNmhZRHM3SkRwakpPYnZlYVpxNjIwcnNRcFk0X3BNRmxYLVRaVDgwZlNuSnRaZzlMYnBGd3BvVHVpOXJzSmVkalVvV3BqMFk1ekhkWDRPZm9zaUF1elZ6OTZTSWpCcXFNU3dzcWJxbzZwZ0JOQ2xZNk5LelRFdG5hV2UwdG96ODNsNXgzYVBrQ29KLVhKTm5DZEdHWjNXZ3dQa2NhaHFGOXlpSENFZEIzVVRnOTJEamx4U1lDSkNITTVFY2tGV3YtZlVoV0JSb285cGdfRXlfRlplR2xaQy15QVJYbFhBTlVuS2NpMW05T3FBQnB2c3R3NndIMFA1QnhFWlBocDJ1WDFDeEVaalNLYnlDenBrYjR4R1dwR3ZUSGJlcWxfdFBaS2Z2Uy15UnFHMkRPRGpud2ZrM3dmdVhibDdxeXl1SkRHRU1haVFPVGNJeldXcjNLaXJ4SDZGUy1hQzlMTjdZdWFoLVlsUmpOZzNUT0YxMG9EcWd4ZUhHb21YN1I2MEpnM0tnTTVtbmlCbEQwQklVcU8xdFJseWxmZlNDbm1QbVUxaHZpdkU4M2ZiVUZjUWFidDFIako5OVZ1VXIzUng2WnZuU3ViZWdZZjlvYTV1VWh6NWNRckxHZGlCeUxWUkdKWk91bXVoMXE1Tmk3MVdic0dUWmU4NFZHUmxUaWpuQzU4YXpZeGhvX1RSWl9fcDRITkZubkhBLUFUQjRBQVhMb1AwMWZiNHZMWGVvdmhQWG5QM3Nranp6RHJDS21hNGNMdkFiczlzYzdyVUJYQ1pjbmhQR09KVHhhcTJWd2wyai1hdmRzRkM1Z0J4QjFKOWE4R0R6dERGN21RVmVKQkRzNFFmVGNpdDltN3V6cTN0RWhEdGc1Y1NjTmlsWnVYOE94bE05M054R2d6SmhQczBhTmJpZXZlU3Bway50cwojRVhULVgtVFdJVENILVBSRUZFVENIOmh0dHBzOi8vdmlkZW8tZWRnZS1jNjg4NGMubGhyMDMuYWJzLmhscy50dHZudy5uZXQvdjEvc2VnbWVudC9DcGNGOTV4VjY1QnVlLTVjWDdVNWRVSjlpeVRWVGE1eTBWUmg3Vks5dG9rOHNSVnRjMk5VVU5zSlhTQjFpOFJPUGQ3ZUJuUWl0M2t6RndHVnVNeEgyZXQxM21UMTJDQmVZY2k5dXc0MU51VFVvanRfTlY1QXZKRERuOVUzRklWU3JvSGQ4NDJqSFlzVDBNV25tMnBmM0IwOEFDOGUwOE92dlNxZ05ReVQ4SGhWLVdUaDRTbUNFZnFXSU45TGpvZXJCTmZJUk5ueU1RWWpKWVVzY2dFbHZuQWxWREpOcDhqbDN1S1VqUlVTVHdoa1dIU3N4TllKenJiRnFJNjRaQW5ZNDdLZWZORG1GVzNOTk90b09henRHeU85c3Bmc2kta2gzRjk0UUNrSy1ZUjRMX0x0VWVJQ2ZJbThxb2NJZ0JzX3hTWkRQemV2QUxJaW9zNjl5cFlheXpEczMwWGkyeDRvekdpZXlfMVhOMjRvRzMwVnhEd1FsMXZOVGxuNGFQbUE0QUtjcWwtVnBSTTlEaEdEd2h0WVRWT2RPUzRFMWJISE9MUm8zZUF0dE4xVVlXeFpvd05adERIcUpnaFlVd1pJSFBmRzRrZjNIQ2J4NHRZWlJJbHJScUl0ajk3ajY2ZTBneGFMVFAza0NDQXYxa2pXMnZWMmJxcW5ZOC1tSlVkQm9Pb0lxTzdEVUUzZ0pFRzN0b2V0WHZvM1MtWlFmVktqR1hhYjFrOF9aWlM4Z29QQXZ1UV9uRGdEQXJqbktIM3RvSkNaZ2poSGFsOF9DdC1lcktXM0pta1ZaQ1Z5eGhZei04WjZBU2lseHI5SXpKaW5JZXdOUVdHU3RIMk5JZml2YUN6TWVCM1NnS3ZwQVlvckZiOXVweGN5b0c2Ry14T0FRWXVEZXJsMDJPaWlENkZ5SnB5QWdwS3dtRW9feVJjeHd0S3dvTU9LN0MyVXp1bkRYeVFaMjVNQm1zd3FiUkxsUU41cVBCSS11YzEtemRjUVRPckE3TXpibl9EcVk3V2ZKWm9RNlc5M3M1SGptMWJ0Z1RJbXBMVXM1OU11WDVLQ09ORHpiakFINDFBYUc4OUk4UWZibXNBR2NHRXNkcVlCLW92X2NrMW5SQjRFQ3ZMbjY3MVNmY3JCdzEybU5hVkNpZ1J0SkhXYUhvQ211RDMwd1k0NFRadFFFaEN1dmF3cnNzXzJnbVZqQ3F6TUNjbFBHZ3dPYXY5ZlVnamZDaVplVjVzLnRzCg==';
                        postMessage({key:'UboShowAdBanner',isMidroll:IsMidroll});
                        HasAd = true;
                    } else {
                        postMessage({key:'UboHideAdBanner',resetPlayer:HasAd});
                        HasAd = false;
                    }
                }
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        var processAfter = async function(response) {
                            var str = await processM3U8(url, await response.text(), realFetch);
                            resolve(new Response(str));
                        };
                        var send = function() {
                            return realFetch(url, options).then(function(response) {
                                processAfter(response);
                            })['catch'](function(err) {
                                console.log('fetch hook err ' + err);
                                reject(err);
                            });
                        };
                        send();
                    });
                }
            }
            return realFetch.apply(this, arguments);
        }
    }
    function resetTwitchPlayer(isPausePlay) {
        // Taken from ttv-tools / ffz
        // https://github.com/Nerixyz/ttv-tools/blob/master/src/context/twitch-player.ts
        // https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/player.jsx
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        var reactRootNode = null;
        var rootNode = document.querySelector('#root');
        if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
            reactRootNode = rootNode._reactRootContainer._internalRoot.current;
        }
        if (!reactRootNode) {
            console.log('Could not find react root');
            return;
        }
        var player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        player.seekTo(0);
    }
})();