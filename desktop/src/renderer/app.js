// ClawFace Desktop - Renderer (dropdown panel)
// Receives status updates via IPC and updates the DOM.

const $ = (id) => document.getElementById(id);

// DOM refs — header
const gatewayDot = $('gateway-dot');
const gatewayLabel = $('gateway-label');
const hostname = $('hostname');

// DOM refs — system metrics
const cpuBar = $('cpu-bar');
const cpuVal = $('cpu-val');
const memBar = $('mem-bar');
const memVal = $('mem-val');
const diskBar = $('disk-bar');
const diskVal = $('disk-val');
const tempVal = $('temp-val');
const netVal = $('net-val');

// DOM refs — OpenClaw expandable
const openclawSection = $('openclaw-section');
const openclawHeader = $('openclaw-header');
const openclawSummary = $('openclaw-summary');
const ocStatus = $('oc-status');
const ocUptime = $('oc-uptime');
const ocAgentsContainer = $('oc-agents-container');
const ocChannels = $('oc-channels');
const ocSessions = $('oc-sessions');
const ocContext = $('oc-context');
const ocTokens = $('oc-tokens');

// DOM refs — AI Usage expandable
const aiSection = $('ai-section');
const aiHeader = $('ai-header');
const aiSummary = $('ai-summary');
const aiProvidersContainer = $('ai-providers-container');
const aiMonth = $('ai-month');
const aiRequests = $('ai-requests');

// DOM refs — pairing
const pairingSection = $('pairing-section');
const pairCodeEl = $('pair-code');
const pairQrEl = $('pair-qr');
const unpairSection = $('unpair-section');
const unpairBtn = $('unpair-btn');

let isPaired = false;

// --- Expand / collapse ---

openclawHeader.addEventListener('click', () => {
  openclawSection.classList.toggle('expanded');
});

aiHeader.addEventListener('click', () => {
  aiSection.classList.toggle('expanded');
});

// --- Helpers ---

function setBar(barEl, valueEl, percent) {
  const p = Math.max(0, Math.min(100, percent));
  barEl.style.width = `${p}%`;
  barEl.classList.remove('warning', 'critical');
  if (p >= 80) barEl.classList.add('critical');
  else if (p >= 60) barEl.classList.add('warning');
  valueEl.textContent = `${Math.round(p)}%`;
}

function formatSpeed(mbps) {
  if (mbps == null || mbps < 0.01) return '0 KB/s';
  if (mbps < 1) return `${Math.round(mbps * 1024)} KB/s`;
  return `${mbps.toFixed(1)} MB/s`;
}

function formatCost(amount) {
  if (amount == null || amount === 0) return '$0.00';
  if (amount >= 1000) return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${amount.toFixed(2)}`;
}

function formatTokens(count) {
  if (count == null || count === 0) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toLocaleString();
}

function formatUptime(seconds) {
  if (!seconds || seconds < 60) return `${Math.round(seconds || 0)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Remove all children from an element (safe alternative to innerHTML = ''). */
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// --- Status update handler ---

window.clawface.onStatusUpdate((status) => {
  // Header
  gatewayDot.classList.remove('disconnected', 'error');
  gatewayLabel.textContent = 'Gateway Running';
  hostname.textContent = status.hostname || '';

  // System metrics
  const sys = status.system;
  setBar(cpuBar, cpuVal, sys.cpu.usage);
  setBar(memBar, memVal, sys.memory.usagePercent);
  setBar(diskBar, diskVal, sys.disk.usagePercent);

  // Detail rows
  tempVal.textContent = sys.temperature?.cpu != null ? `${Math.round(sys.temperature.cpu)}\u00B0C` : '--';
  netVal.textContent = `\u2191 ${formatSpeed(sys.network?.uploadMBps)}  \u2193 ${formatSpeed(sys.network?.downloadMBps)}`;

  // OpenClaw section
  const oc = status.openclaw;
  if (oc) {
    updateOpenClaw(oc);
  }

  // AI Usage section
  const ai = status.aiUsage;
  if (ai) {
    updateAiUsage(ai);
  }
});

// --- OpenClaw data ---

function updateOpenClaw(oc) {
  // Summary line
  const activeCount = oc.sessions?.active ?? 0;
  const version = oc.version ? `v${oc.version}` : '';
  openclawSummary.textContent = `${version}  ${activeCount} active`;

  // Expanded details
  ocStatus.textContent = oc.status || '--';
  ocUptime.textContent = formatUptime(oc.uptime);

  // Agents
  clearChildren(ocAgentsContainer);
  if (oc.agents && oc.agents.length > 0) {
    const label = document.createElement('div');
    label.className = 'agents-label';
    label.textContent = 'Agents';
    ocAgentsContainer.appendChild(label);

    for (const agent of oc.agents) {
      const row = document.createElement('div');
      row.className = 'agent-row';

      const name = document.createElement('span');
      name.className = 'agent-name';
      name.textContent = agent.name || agent.id;
      row.appendChild(name);

      const activity = document.createElement('span');
      activity.className = `agent-activity ${agent.activity || 'idle'}`;
      activity.textContent = agent.activity || 'idle';
      row.appendChild(activity);

      if (agent.model) {
        const model = document.createElement('span');
        model.className = 'model-name';
        model.textContent = agent.model;
        model.style.marginLeft = 'auto';
        row.appendChild(model);
      }

      ocAgentsContainer.appendChild(row);
    }
  }

  // Channels
  if (oc.channels) {
    const parts = [];
    for (const [name, ch] of Object.entries(oc.channels)) {
      if (ch && typeof ch === 'object') {
        const dot = ch.connected ? '\u25CF' : '\u25CB';
        parts.push(`${name} ${dot}`);
      }
    }
    ocChannels.textContent = parts.length > 0 ? parts.join('  ') : '--';
  }

  // Sessions
  const active = oc.sessions?.active ?? 0;
  const total = oc.sessions?.total ?? 0;
  ocSessions.textContent = `${active} active / ${total} total`;

  // Context
  if (oc.context) {
    ocContext.textContent = `${formatTokens(oc.context.used)} / ${formatTokens(oc.context.limit)}`;
  }

  // Tokens
  if (oc.tokens) {
    ocTokens.textContent = `\u2191 ${formatTokens(oc.tokens.input)}  \u2193 ${formatTokens(oc.tokens.output)}`;
  }
}

// --- AI Usage data ---

function updateAiUsage(ai) {
  // Summary line
  aiSummary.textContent = `${formatCost(ai.totalCostToday)} today`;

  // This Month + Requests totals
  aiMonth.textContent = formatCost(ai.totalCostThisMonth);

  let totalRequests = 0;
  if (ai.providers) {
    for (const p of ai.providers) {
      totalRequests += p.requests || 0;
    }
  }
  aiRequests.textContent = totalRequests.toLocaleString();

  // Provider cards
  clearChildren(aiProvidersContainer);
  if (ai.providers && ai.providers.length > 0) {
    for (const provider of ai.providers) {
      const card = document.createElement('div');
      card.className = 'provider-card';

      // Provider header
      const header = document.createElement('div');
      header.className = 'provider-header';

      const pName = document.createElement('span');
      pName.className = 'provider-name';
      pName.textContent = provider.name || provider.provider || 'Unknown';
      header.appendChild(pName);

      const pCost = document.createElement('span');
      pCost.className = 'provider-cost';
      pCost.textContent = formatCost(provider.estimatedCost);
      header.appendChild(pCost);

      card.appendChild(header);

      // Model rows
      if (provider.models && provider.models.length > 0) {
        for (const model of provider.models) {
          const mRow = document.createElement('div');
          mRow.className = 'model-row';

          const mName = document.createElement('span');
          mName.className = 'model-name';
          mName.textContent = model.model;
          mRow.appendChild(mName);

          const mCost = document.createElement('span');
          mCost.className = 'model-cost';
          mCost.textContent = formatCost(model.totalCost);
          mRow.appendChild(mCost);

          card.appendChild(mRow);
        }
      }

      aiProvidersContainer.appendChild(card);
    }
  }
}

// --- Gateway state changes ---

window.clawface.onGatewayState((state) => {
  if (state.running && state.relayConnected) {
    isPaired = true;
    pairingSection.style.display = 'none';
    unpairSection.style.display = '';
  } else if (state.running && !state.relayConnected) {
    isPaired = false;
    pairingSection.style.display = '';
    unpairSection.style.display = 'none';
  } else {
    // Gateway stopped
    gatewayDot.classList.add('disconnected');
    gatewayLabel.textContent = 'Gateway Stopped';
    isPaired = false;
    pairingSection.style.display = '';
    unpairSection.style.display = 'none';
  }
});

// --- Pairing code ---

function handlePairData(data) {
  if (!data || !data.code) return;
  pairCodeEl.textContent = data.code;
  if (data.qrDataUrl) {
    pairQrEl.src = data.qrDataUrl;
  }
  if (!isPaired) {
    pairingSection.style.display = '';
  }
}

window.clawface.onPairCode(handlePairData);
window.clawface.getPairData().then(handlePairData).catch(() => {});

// --- Unpair button ---

unpairBtn.addEventListener('click', () => {
  window.clawface.unpair();
});

// --- Footer link ---

$('clawface-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.clawface.openExternal('https://clawface.app');
});
