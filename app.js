const { generateSecretKey, getPublicKey, finalizeEvent } = NostrTools;
const { npubEncode, nsecEncode } = NostrTools.nip19;
const { bytesToHex } = NostrTools.utils;
const { SimplePool } = NostrTools;

const pool = new SimplePool();
const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

let workers = [];
let miningActive = false;
let startTime = null;
let totalKeysChecked = 0;
let foundResults = [];
let maxResults = 3;
let hasUserTipped = false;
let currentInvoice = null;
let currentPaymentAmount = 0;
let paymentSubscription = null;
let paymentPollInterval = null;

const DEVELOPER_LIGHTNING_ADDRESS = '69420@wallet.yakihonne.com';
const DEVELOPER_NPUB = 'npub16jd6qg3zrkdpk0yvxqmt9803ysmc3d9c3ct5x9vkqlt0kxgs02lsj2lr3d';
const RECIPIENT_PUBKEY = 'd49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df';

const prefixInput = document.getElementById('prefixInput');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const miningStatus = document.getElementById('miningStatus');
const resultsSection = document.getElementById('resultsSection');
const difficultyText = document.getElementById('difficultyText');
const difficultyBar = document.getElementById('difficultyBar');
const keysCheckedEl = document.getElementById('keysChecked');
const keysPerSecondEl = document.getElementById('keysPerSecond');
const elapsedTimeEl = document.getElementById('elapsedTime');
const currentAttemptEl = document.getElementById('currentAttempt');
const threadSlider = document.getElementById('threadSlider');
const threadCount = document.getElementById('threadCount');
const coreCount = document.getElementById('coreCount');
const tipModal = document.getElementById('tipModal');
const multipleVariationsCheckbox = document.getElementById('multipleVariations');

const BECH32_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function init() {
    const cores = navigator.hardwareConcurrency || 4;
    coreCount.textContent = `${cores} cores available`;
    threadSlider.max = Math.min(cores * 2, 32);
    threadSlider.value = Math.min(cores, 8);
    updateThreadDisplay();

    updateDifficulty('');

    prefixInput.addEventListener('input', handlePrefixChange);
    threadSlider.addEventListener('input', updateThreadDisplay);
    startBtn.addEventListener('click', startMining);
    stopBtn.addEventListener('click', stopMining);
    multipleVariationsCheckbox.addEventListener('change', handleVariationsChange);

    document.getElementById('closeTipModal').addEventListener('click', closeTipModal);

    document.querySelectorAll('.tip-amount-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const amount = btn.dataset.amount;
            handleTipAmount(amount);
        });
    });

    tipModal.addEventListener('click', (e) => {
        if (e.target === tipModal) closeTipModal();
    });
}

function updateThreadDisplay() {
    threadCount.textContent = `${threadSlider.value} threads`;
    if (prefixInput.value) {
        updateDifficulty(prefixInput.value);
    }
}

function handleVariationsChange() {
    maxResults = multipleVariationsCheckbox.checked ? 3 : 1;
    if (prefixInput.value) {
        updateDifficulty(prefixInput.value);
    }
}

function handlePrefixChange() {
    let value = prefixInput.value.toLowerCase();

    value = value.split('').filter(c => BECH32_CHARS.includes(c)).join('');
    prefixInput.value = value;

    updateDifficulty(value);
    startBtn.disabled = value.length === 0;
}

function updateDifficulty(prefix) {
    if (!prefix) {
        const position = document.querySelector('input[name="position"]:checked').value;
        let emptyText = 'Enter a prefix';
        if (position === 'suffix') {
            emptyText = 'Enter a suffix';
        } else if (position === 'contains') {
            emptyText = 'Enter a pattern';
        }
        difficultyText.textContent = emptyText;
        difficultyBar.style.width = '0%';
        difficultyBar.className = 'difficulty-fill';
        return;
    }

    const len = prefix.length;
    const position = document.querySelector('input[name="position"]:checked').value;

    let attemptsPerMatch = Math.pow(32, len);

    if (position === 'contains') {
        const searchableLength = 58;
        const possiblePositions = searchableLength - len + 1;
        attemptsPerMatch = attemptsPerMatch / possiblePositions;
    }

    const expectedAttempts = attemptsPerMatch * maxResults;

    let difficulty, className, percentage;

    if (len <= 2) {
        difficulty = 'Easy';
        className = 'difficulty-easy';
        percentage = 25;
    } else if (len <= 3) {
        difficulty = 'Medium';
        className = 'difficulty-medium';
        percentage = 50;
    } else if (len <= 4) {
        difficulty = 'Hard';
        className = 'difficulty-hard';
        percentage = 75;
    } else {
        difficulty = 'Extreme';
        className = 'difficulty-extreme';
        percentage = 100;
    }

    const timeEstimate = getTimeEstimate(expectedAttempts);
    const resultsText = maxResults === 1 ? '1 result' : `${maxResults} results`;
    difficultyText.textContent = `${difficulty} — ~${timeEstimate} for ${resultsText}`;
    difficultyBar.className = `difficulty-fill ${className}`;
    difficultyBar.style.width = `${percentage}%`;
}

function getTimeEstimate(attempts) {
    const keysPerSecond = 3500 * parseInt(threadSlider.value);
    const seconds = attempts / keysPerSecond;

    if (seconds < 1) return 'instant';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    if (seconds < 604800) return `${Math.round(seconds / 86400)}d`;
    return `${Math.round(seconds / 604800)}w+`;
}

function startMining() {
    const prefix = prefixInput.value.toLowerCase();
    const position = document.querySelector('input[name="position"]:checked').value;
    const numThreads = parseInt(threadSlider.value);

    if (!prefix) return;

    miningActive = true;
    startTime = Date.now();
    totalKeysChecked = 0;
    foundResults = [];

    miningStatus.classList.add('active');
    resultsSection.classList.remove('active');
    startBtn.disabled = true;

    updateMiningStatusText();

    const workerCode = `
        importScripts('https://unpkg.com/nostr-tools@2.10.0/lib/nostr.bundle.js');

        function bytesToHex(bytes) {
            return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        }

        self.onmessage = async (e) => {
            const { prefix, position, maxResults } = e.data;
            const { generateSecretKey, getPublicKey } = NostrTools;
            const { npubEncode, nsecEncode } = NostrTools.nip19;

            let checked = 0;
            let resultsFound = 0;

            while (resultsFound < maxResults) {
                const sk = generateSecretKey();
                const pk = getPublicKey(sk);
                const npub = npubEncode(pk);
                const nsec = nsecEncode(sk);

                checked++;

                const searchPart = npub.slice(5);
                let found = false;

                if (position === 'prefix') {
                    found = searchPart.startsWith(prefix);
                } else if (position === 'suffix') {
                    found = searchPart.endsWith(prefix);
                } else {
                    found = searchPart.includes(prefix);
                }

                if (found) {
                    self.postMessage({
                        type: 'found',
                        npub,
                        nsec,
                        sk: bytesToHex(sk),
                        pk
                    });
                    resultsFound++;
                }

                if (checked % 1000 === 0) {
                    self.postMessage({
                        type: 'progress',
                        checked: 1000,
                        currentNpub: npub
                    });
                    checked = 0;

                    await new Promise(r => setTimeout(r, 0));
                }
            }
        };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);

    for (let i = 0; i < numThreads; i++) {
        const worker = new Worker(workerUrl);

        worker.onmessage = (e) => {
            if (e.data.type === 'progress') {
                totalKeysChecked += e.data.checked;
                animateCurrentAttempt(e.data.currentNpub);
            } else if (e.data.type === 'found') {
                handleFound(e.data, worker);
            }
        };

        worker.postMessage({ prefix, position, maxResults: maxResults });
        workers.push(worker);
    }

    updateStats();
}

function updateStats() {
    if (!miningActive) return;

    const elapsed = (Date.now() - startTime) / 1000;
    const kps = Math.round(totalKeysChecked / elapsed);

    keysCheckedEl.textContent = formatNumber(totalKeysChecked);
    keysPerSecondEl.textContent = formatNumber(kps);
    elapsedTimeEl.textContent = formatTime(elapsed);

    requestAnimationFrame(() => setTimeout(updateStats, 100));
}

function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function handleFound(data, worker) {
    foundResults.push(data);
    console.log(`Found ${foundResults.length}/${maxResults} results`);

    updateMiningStatusText();

    if (foundResults.length >= maxResults) {
        stopMining();
        displayResults();
    }
}

function updateMiningStatusText() {
    const statusTitle = document.querySelector('.status-title');
    if (statusTitle) {
        const foundCount = foundResults.length;
        const variationsText = maxResults === 1 ? 'match' : `${maxResults} variations`;
        if (foundCount === 0) {
            statusTitle.innerHTML = `<div class="pulse-dot"></div>Mining for ${variationsText}...`;
        } else {
            statusTitle.innerHTML = `<div class="pulse-dot"></div>Found ${foundCount}/${maxResults} - mining more...`;
        }
    }
}

function displayResults() {
    miningStatus.classList.remove('active');
    resultsSection.classList.add('active');

    const position = document.querySelector('input[name="position"]:checked').value;
    let resetButtonText = 'Try Different Prefix';
    if (position === 'suffix') {
        resetButtonText = 'Try Different Suffix';
    } else if (position === 'contains') {
        resetButtonText = 'Try Different Pattern';
    }

    const resultsHTML = foundResults.map((result, index) => `
        <div class="result-card" id="result${index}">
            <div class="result-label">Variation #${index + 1} - Public Key (npub)</div>
            <div class="result-value" id="npubText${index}">
                ${result.npub}
                <button class="copy-btn" onclick="copyResult('npubText${index}')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
            </div>
            <div class="result-label">Private Key (nsec) - Keep this secret!</div>
            <div class="result-value nsec" id="nsecText${index}">
                ${result.nsec}
                <button class="copy-btn" onclick="copyResult('nsecText${index}')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    const keysText = maxResults === 1 ? 'Matching Key!' : `${maxResults} Matching Keys!`;
    const mineMoreText = maxResults === 1 ? 'Mine Another' : `Mine ${maxResults} More Variations`;

    const resultsContainer = document.getElementById('resultsSection');
    resultsContainer.innerHTML = `
        <h3 style="margin-bottom: 1rem; color: var(--accent-cyan); display: flex; align-items: center; gap: 0.5rem;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                <line x1="9" y1="9" x2="9.01" y2="9"></line>
                <line x1="15" y1="9" x2="15.01" y2="9"></line>
            </svg>
            Found ${keysText}
        </h3>
        ${resultsHTML}
        <div class="tip-section" style="background: linear-gradient(135deg, rgba(249, 115, 22, 0.1), rgba(251, 191, 36, 0.1)); border: 1px solid rgba(249, 115, 22, 0.3); border-radius: 12px; padding: 1.5rem; margin: 1.5rem 0; text-align: center;">
            <div style="font-size: 2rem; margin-bottom: 0.5rem;">⚡</div>
            <h4 style="margin-bottom: 0.5rem;">Enjoying Vanity Npub?</h4>
            <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem;">
                This tool is free and open source. Consider sending a tip to support development!
            </p>
            <button class="btn btn-lightning" onclick="showTipModal()" style="margin: 0 auto;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
                Send a Tip
            </button>
        </div>
        <div class="result-actions">
            <button class="btn btn-primary" onclick="mineMoreVariations()">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
                ${mineMoreText}
            </button>
            <button class="btn btn-secondary" onclick="resetMiner()" id="resetBtn">
                ${resetButtonText}
            </button>
        </div>
        <div class="warning-box">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
            </svg>
            <p><strong>Important:</strong> Save your private keys (nsec) securely! Anyone with access to your private key can control your Nostr identity. Never share it with anyone.</p>
        </div>
    `;
    resultsContainer.classList.add('active');
}

function stopMining() {
    miningActive = false;
    workers.forEach(w => w.terminate());
    workers = [];
    startBtn.disabled = prefixInput.value.length === 0;
    miningStatus.classList.remove('active');
}

window.showTipModal = function () {
    window.tipModalOriginalContent = null;
    tipModal.classList.add('active');
};

function closeTipModal() {
    tipModal.classList.remove('active');

    if (paymentPollInterval) {
        clearInterval(paymentPollInterval);
        paymentPollInterval = null;
    }

    if (paymentSubscription) {
        paymentSubscription.close();
        paymentSubscription = null;
    }
}

async function handleTipAmount(amount) {
    console.log(`User selected tip amount: ${amount} sats`);

    currentPaymentAmount = amount;

    const modalContent = document.querySelector('#tipModal .modal');
    if (!window.tipModalOriginalContent) {
        window.tipModalOriginalContent = modalContent.innerHTML;
    }

    showGeneratingInvoice(amount);

    const lightningAddress = DEVELOPER_LIGHTNING_ADDRESS;
    const amountMillisats = amount * 1000;

    if (typeof window.webln !== 'undefined') {
        try {
            await window.webln.enable();
            const invoice = await fetchLNURLInvoice(lightningAddress, amountMillisats);
            if (invoice) {
                currentInvoice = invoice;
                await window.webln.sendPayment(invoice);
                hasUserTipped = true;
                showThankYouMessage();
                return;
            }
        } catch (err) {
            console.error('WebLN payment failed:', err);
        }
    }

    try {
        const invoice = await fetchLNURLInvoice(lightningAddress, amountMillisats);
        if (invoice) {
            currentInvoice = invoice;
            showInvoiceQR(invoice, amount);
        }
    } catch (err) {
        console.error('Failed to fetch invoice:', err);
        window.open(`lightning:${lightningAddress}?amount=${amountMillisats}`, '_blank');
    }
}

function showGeneratingInvoice(amount) {
    const modalContent = document.querySelector('#tipModal .modal');
    modalContent.innerHTML = `
        <div style="text-align: center;">
            <div class="lightning-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
            </div>
            <h2 class="modal-title">Generating Invoice</h2>
            <p class="modal-subtitle">Creating ${amount} sats Lightning invoice...</p>
            <div style="margin: 2rem 0;">
                <div style="width: 40px; height: 40px; border: 3px solid var(--border-color); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto;"></div>
            </div>
        </div>
        <style>
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
        </style>
    `;
}

function showThankYouMessage() {
    const modalContent = document.querySelector('#tipModal .modal');
    modalContent.innerHTML = `
        <div style="text-align: center;">
            <div style="font-size: 4rem; margin-bottom: 1rem;">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block;">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                    <line x1="9" y1="9" x2="9.01" y2="9"></line>
                    <line x1="15" y1="9" x2="15.01" y2="9"></line>
                </svg>
            </div>
            <h2 class="modal-title">Thank You!</h2>
            <p class="modal-subtitle">Your support helps keep this project free and open source.</p>
            <button class="btn btn-primary" onclick="closeTipModalToOriginal()" style="margin-top: 1.5rem;">Continue Mining</button>
        </div>
    `;
}

async function fetchLNURLInvoice(lightningAddress, amountMillisats) {
    try {
        const [username, domain] = lightningAddress.split('@');
        const lnurlResponse = await fetch(`https://${domain}/.well-known/lnurlp/${username}`);
        const lnurlData = await lnurlResponse.json();

        if (lnurlData.callback && lnurlData.allowsNostr) {
            console.log('✅ LNURL endpoint supports Nostr zaps');

            const sk = generateSecretKey();
            const pk = getPublicKey(sk);

            const zapRequestTemplate = {
                kind: 9734,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['p', RECIPIENT_PUBKEY],
                    ['amount', amountMillisats.toString()],
                    ['relays', ...RELAYS]
                ],
                content: 'Tip for Vanity Npub - Thank you for this tool!',
            };

            const zapRequest = finalizeEvent(zapRequestTemplate, sk);

            console.log('✅ Zap request created:', zapRequest.id);
            console.log('📝 Sending zap request to LNURL callback (per NIP-57)');

            const callbackUrl = `${lnurlData.callback}${lnurlData.callback.includes('?') ? '&' : '?'}amount=${amountMillisats}&nostr=${encodeURIComponent(JSON.stringify(zapRequest))}`;
            const invoiceResponse = await fetch(callbackUrl);
            const invoiceData = await invoiceResponse.json();

            console.log('✅ Invoice generated with zap support');
            return invoiceData.pr;
        } else if (lnurlData.callback) {
            console.log('⚠️ LNURL endpoint does not support Nostr zaps, generating regular invoice');
            const callbackUrl = `${lnurlData.callback}${lnurlData.callback.includes('?') ? '&' : '?'}amount=${amountMillisats}`;
            const invoiceResponse = await fetch(callbackUrl);
            const invoiceData = await invoiceResponse.json();
            return invoiceData.pr;
        }
    } catch (err) {
        console.error('Failed to fetch LNURL invoice:', err);
        return null;
    }
}

async function showInvoiceQR(invoice, amount) {
    const modalContent = document.querySelector('#tipModal .modal');

    modalContent.innerHTML = `
        <h2 class="modal-title">Tip ${amount} sats</h2>
        <p class="modal-subtitle">Scan with your Lightning wallet</p>
        <div style="background: white; padding: 1rem; border-radius: 12px; margin: 1.5rem 0;">
            <canvas id="tipQRCanvas"></canvas>
        </div>
        <div style="font-family: 'JetBrains Mono', monospace; font-size: 0.7rem; word-break: break-all; background: var(--bg-primary); padding: 1rem; border-radius: 8px; margin-bottom: 1rem; max-height: 80px; overflow-y: auto;">${invoice}</div>
        <div id="paymentStatus" style="text-align: center; color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem;">
            Waiting for payment...
        </div>
        <button class="btn btn-secondary" onclick="copyTipInvoice('${invoice}')" style="width: 100%; margin-bottom: 0.5rem;">Copy Invoice</button>
        <button class="modal-close" onclick="closeTipModalToOriginal()">Cancel</button>
    `;

    if (window.QRCode) {
        try {
            await QRCode.toCanvas(
                document.getElementById('tipQRCanvas'),
                `lightning:${invoice.toUpperCase()}`,
                { width: 256, margin: 2, color: { dark: '#000', light: '#fff' } }
            );
        } catch (err) {
            console.error('Failed to generate QR code:', err);
        }
    }

    startPaymentPolling();
}

function extractAmountFromBolt11(bolt11) {
    try {
        const lowerInvoice = bolt11.toLowerCase();

        const match = lowerInvoice.match(/^ln[a-z]{2,}?(\d+)([munp])?/);
        if (!match) return 0;

        let amount = parseInt(match[1]);
        const multiplier = match[2];

        if (multiplier === 'm') amount = amount / 1000;
        else if (multiplier === 'u') amount = amount / 1000000;
        else if (multiplier === 'n') amount = amount / 1000000000;
        else if (multiplier === 'p') amount = amount / 1000000000000;

        return Math.round(amount);
    } catch (err) {
        console.error('Failed to extract amount from bolt11:', err);
        return 0;
    }
}

async function checkPaymentStatus() {
    if (!currentInvoice || !currentPaymentAmount) return false;

    return new Promise((resolve) => {
        let foundPayment = false;

        const filter = {
            kinds: [9735],
            '#p': [RECIPIENT_PUBKEY],
            since: Math.floor(Date.now() / 1000) - 600
        };

        console.log('🔍 Subscribing to ALL zap receipts for recipient pubkey');
        console.log('📡 Will match by bolt11 invoice or amount');
        console.log('📡 Subscription filter:', JSON.stringify(filter, null, 2));
        console.log('📡 Listening on relays:', RELAYS);

        if (paymentSubscription) {
            paymentSubscription.close();
        }

        paymentSubscription = pool.subscribeMany(
            RELAYS,
            [filter],
            {
                onevent(event) {
                    if (foundPayment) return;

                    console.log('📨 Received zap receipt event:', {
                        id: event.id,
                        created: new Date(event.created_at * 1000).toISOString(),
                        tags: event.tags,
                        pubkey: event.pubkey
                    });

                    try {
                        const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
                        if (!bolt11Tag || !bolt11Tag[1]) {
                            console.log('No bolt11 tag found');
                            return;
                        }

                        const receiptInvoice = bolt11Tag[1].replace(/^lightning:/i, '').toLowerCase().trim();
                        const ourInvoice = currentInvoice.replace(/^lightning:/i, '').toLowerCase().trim();

                        const invoiceMatches = receiptInvoice === ourInvoice;
                        const receiptAmount = extractAmountFromBolt11(bolt11Tag[1]);
                        const amountMatches = Math.abs(receiptAmount - currentPaymentAmount) < 10;

                        console.log('Checking match:', {
                            invoiceMatches,
                            amountMatches,
                            receiptAmount,
                            expectedAmount: currentPaymentAmount
                        });

                        if (invoiceMatches || amountMatches) {
                            console.log('✅ Payment verified via zap receipt!');
                            console.log('Matching zap receipt:', event);
                            foundPayment = true;

                            if (paymentSubscription) {
                                paymentSubscription.close();
                                paymentSubscription = null;
                            }

                            resolve(true);
                        }
                    } catch (err) {
                        console.error('Error processing zap receipt:', err);
                    }
                },
                oneose() {
                    console.log('📡 Finished loading stored events, now listening for real-time zap receipts...');
                }
            }
        );

        setTimeout(() => {
            if (!foundPayment) {
                resolve(false);
            }
        }, 3000);
    });
}

function startPaymentPolling() {
    if (paymentPollInterval) {
        console.log('Clearing existing payment poll interval');
        clearInterval(paymentPollInterval);
    }

    console.log('Starting payment polling...');

    checkPaymentStatus().then(paid => {
        if (paid) {
            console.log('Payment confirmed on initial check!');
            hasUserTipped = true;

            const statusEl = document.getElementById('paymentStatus');
            if (statusEl) {
                statusEl.innerHTML = '<span style="color: var(--accent-cyan);">✓ Payment confirmed!</span>';
            }

            setTimeout(() => {
                showThankYouMessage();
            }, 1000);
            return;
        }
        console.log('Initial payment check: not paid yet');
    });

    let checkCount = 0;
    paymentPollInterval = setInterval(async () => {
        checkCount++;
        console.log(`Payment check #${checkCount}`);

        const paid = await checkPaymentStatus();
        if (paid) {
            console.log('🎉 Payment confirmed!');
            clearInterval(paymentPollInterval);
            paymentPollInterval = null;
            hasUserTipped = true;

            const statusEl = document.getElementById('paymentStatus');
            if (statusEl) {
                statusEl.innerHTML = '<span style="color: var(--accent-cyan);">✓ Payment confirmed!</span>';
            }

            setTimeout(() => {
                showThankYouMessage();
            }, 1000);
        }

        if (checkCount >= 150) {
            console.log('Payment polling timeout after 5 minutes');
            clearInterval(paymentPollInterval);
            paymentPollInterval = null;
        }
    }, 2000);
}

window.closeTipModalToOriginal = function () {
    if (paymentPollInterval) {
        clearInterval(paymentPollInterval);
        paymentPollInterval = null;
    }

    if (paymentSubscription) {
        paymentSubscription.close();
        paymentSubscription = null;
    }

    const modalContent = document.querySelector('#tipModal .modal');
    if (window.tipModalOriginalContent) {
        modalContent.innerHTML = window.tipModalOriginalContent;

        document.getElementById('closeTipModal').addEventListener('click', closeTipModal);
        document.querySelectorAll('.tip-amount-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const amount = btn.dataset.amount;
                handleTipAmount(amount);
            });
        });

        window.tipModalOriginalContent = null;
    }
    closeTipModal();
};

window.copyTipInvoice = function (invoice) {
    navigator.clipboard.writeText(invoice).then(() => {
        alert('Invoice copied to clipboard!');
    });
};

window.resetMiner = function () {
    resultsSection.classList.remove('active');
    prefixInput.value = '';
    startBtn.disabled = true;
    updateDifficulty('');
};

window.copyResult = function (elementId) {
    const text = document.getElementById(elementId).textContent.trim();
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector(`#${elementId} .copy-btn`);
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
            btn.innerHTML = originalHTML;
        }, 2000);
    });
};

window.mineMoreVariations = function () {
    if (!hasUserTipped) {
        showTipModal();
        setTimeout(() => {
            foundResults = [];
            startMining();
        }, 100);
    } else {
        foundResults = [];
        startMining();
    }
};

function animateCurrentAttempt(npub) {
    if (!currentAttemptEl) return;

    currentAttemptEl.textContent = npub;
    currentAttemptEl.style.opacity = '0.6';
    setTimeout(() => {
        if (currentAttemptEl) currentAttemptEl.style.opacity = '1';
    }, 50);
}

document.querySelectorAll('input[name="position"]').forEach(radio => {
    radio.addEventListener('change', () => {
        updatePatternLabels();
        updateDifficulty(prefixInput.value);
    });
});

function updatePatternLabels() {
    const position = document.querySelector('input[name="position"]:checked').value;
    const patternLabel = document.getElementById('patternLabel');
    const patternHint = document.getElementById('patternHint');
    const prefixStatic = document.getElementById('prefixStatic');
    const prefixInput = document.getElementById('prefixInput');

    if (position === 'prefix') {
        patternLabel.textContent = 'Desired Prefix';
        patternHint.textContent = 'Enter the characters you want at the start (a-z, 0-9 only, no 1, b, i, o)';
        prefixStatic.textContent = 'npub1';
        prefixInput.placeholder = 'h0dl';
    } else if (position === 'suffix') {
        patternLabel.textContent = 'Desired Suffix';
        patternHint.textContent = 'Enter the characters you want at the end (a-z, 0-9 only, no 1, b, i, o)';
        prefixStatic.textContent = 'npub1...';
        prefixInput.placeholder = 'zap';
    } else {
        patternLabel.textContent = 'Desired Pattern';
        patternHint.textContent = 'Enter the characters you want anywhere in the key (a-z, 0-9 only, no 1, b, i, o)';
        prefixStatic.textContent = 'npub1';
        prefixInput.placeholder = 'n0str';
    }
}

init();
