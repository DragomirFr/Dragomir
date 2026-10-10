/**
 * Dragomir Centralized Realtime Sync Engine (site-sync.js)
 * Synchronizes hero text, banners, Spotify, social links, theme, and maintenance mode
 * live across all pages for every visitor via Firebase Realtime Database.
 */

(function () {
  'use strict';

  const STORAGE_CONFIG_KEY = 'dragomir_site_config';
  const STORAGE_FIREBASE_KEY = 'dragomir_firebase_config';

  const DEFAULT_CONFIG = {
    hero: {
      title: "Dragomir",
      subtitle: "",
      showSubtitle: false
    },
    banner: {
      enabled: false,
      text: "Welcome to my website!",
      type: "info", // "info", "success", "warning", "accent"
      dismissible: true
    },
    spotify: {
      enabled: false,
      clientId: "",
      refreshToken: "",
      demoMode: false
    },
    socials: {
      discord: "https://discord.com",
      github: "https://github.com",
      customLabel: "",
      customUrl: ""
    },
    pages: {
      clockEnabled: true,
      vaultEnabled: true,
      maintenanceMode: false,
      maintenanceMessage: "Website is currently undergoing brief maintenance. Please check back soon."
    },
    theme: {
      accentColor: "#7877c6",
      accentGlow: "rgba(120, 119, 198, 0.12)"
    },
    updatedAt: Date.now()
  };

  let currentConfig = { ...DEFAULT_CONFIG };
  let firebaseApp = null;
  let firebaseDb = null;
  let isListening = false;

  // --- CONFIG ACCESSORS ---
  function getLocalConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
      if (raw) {
        return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
      }
    } catch (e) {}
    return { ...DEFAULT_CONFIG };
  }

  const DEFAULT_FIREBASE_CONFIG = {
    databaseURL: "https://admin-dragomir-default-rtdb.europe-west1.firebasedatabase.app"
  };

  function getFirebaseConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_FIREBASE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}

    // Check script tag fallback
    const scriptTag = document.getElementById('firebaseConfigData');
    if (scriptTag && scriptTag.textContent.trim()) {
      try {
        return JSON.parse(scriptTag.textContent.trim());
      } catch (e) {}
    }

    return { ...DEFAULT_FIREBASE_CONFIG };
  }

  function setFirebaseConfig(cfg) {
    if (!cfg) {
      localStorage.removeItem(STORAGE_FIREBASE_KEY);
    } else {
      localStorage.setItem(STORAGE_FIREBASE_KEY, JSON.stringify(cfg));
    }
  }

  function deepMerge(target, source) {
    const output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
          if (!(key in target)) Object.assign(output, { [key]: source[key] });
          else output[key] = deepMerge(target[key], source[key]);
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  function isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  // --- FIREBASE SCRIPT LOADER ---
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = (err) => reject(err);
      document.head.appendChild(s);
    });
  }

  async function ensureFirebaseLoaded() {
    if (window.firebase && window.firebase.database) return true;
    try {
      await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js');
      return true;
    } catch (e) {
      console.warn('[SiteSync] Failed to load Firebase CDN scripts:', e);
      return false;
    }
  }

  // --- INIT FIREBASE REALTIME LISTENER ---
  async function initFirebaseSync() {
    const fbConfig = getFirebaseConfig();
    if (!fbConfig || !fbConfig.databaseURL) {
      return false;
    }

    // 1. Immediate fast REST fetch (loads live changes instantly on page load)
    const cleanUrl = fbConfig.databaseURL.replace(/\/+$/, '');
    fetch(`${cleanUrl}/siteConfig.json`)
      .then(res => res.json())
      .then(val => {
        if (val) {
          currentConfig = deepMerge(DEFAULT_CONFIG, val);
          localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(currentConfig));
          applyLiveChanges(currentConfig);
          window.dispatchEvent(new CustomEvent('siteConfigUpdated', { detail: currentConfig }));
        }
      })
      .catch(() => {});

    // 2. Persistent real-time WebSocket listener via Firebase SDK
    const loaded = await ensureFirebaseLoaded();
    if (!loaded || !window.firebase) return true;

    try {
      if (!window.firebase.apps.length) {
        firebaseApp = window.firebase.initializeApp(fbConfig);
      } else {
        firebaseApp = window.firebase.apps[0];
      }

      firebaseDb = window.firebase.database();

      if (!isListening) {
        isListening = true;
        firebaseDb.ref('siteConfig').on('value', (snapshot) => {
          const val = snapshot.val();
          if (val) {
            currentConfig = deepMerge(DEFAULT_CONFIG, val);
            localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(currentConfig));
            applyLiveChanges(currentConfig);
            window.dispatchEvent(new CustomEvent('siteConfigUpdated', { detail: currentConfig }));
          }
        }, (err) => {
          console.warn('[SiteSync] RTDB listen error:', err);
        });
      }
      return true;
    } catch (err) {
      console.warn('[SiteSync] Firebase initialization error:', err);
      return false;
    }
  }

  // --- APPLY LIVE CHANGES TO THE DOM ---
  function applyLiveChanges(config) {
    if (!config) return;

    // 1. Theme / Glow color
    if (config.theme && config.theme.accentGlow) {
      document.documentElement.style.setProperty('--site-accent-glow', config.theme.accentGlow);
      document.documentElement.style.setProperty('--site-accent-color', config.theme.accentColor || '#7877c6');
      
      const body = document.body;
      if (body) {
        body.style.backgroundImage = `
          radial-gradient(ellipse 80% 50% at 50% -20%, ${config.theme.accentGlow}, transparent),
          radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.02), transparent 70%)
        `;
      }
    }

    // 2. Global Live Announcement Banner
    updateLiveBanner(config.banner);

    // 3. Maintenance Mode
    handleMaintenanceMode(config.pages);

    // 4. Hero text (index.html)
    const heroH1 = document.querySelector('main h1');
    if (heroH1 && config.hero && config.hero.title) {
      heroH1.textContent = config.hero.title;
    }

    let subtitleEl = document.getElementById('heroLiveSubtitle');
    if (heroH1 && config.hero) {
      if (config.hero.showSubtitle && config.hero.subtitle) {
        if (!subtitleEl) {
          subtitleEl = document.createElement('p');
          subtitleEl.id = 'heroLiveSubtitle';
          subtitleEl.className = 'hero-live-subtitle';
          heroH1.insertAdjacentElement('afterend', subtitleEl);
        }
        subtitleEl.textContent = config.hero.subtitle;
        subtitleEl.style.display = 'block';
      } else if (subtitleEl) {
        subtitleEl.style.display = 'none';
      }
    }

    // 5. Page Navigation buttons (in footer)
    const clockBtn = document.querySelector('a[href="clock.html"]');
    if (clockBtn && config.pages) {
      clockBtn.style.display = config.pages.clockEnabled !== false ? 'inline-flex' : 'none';
    }

    const vaultBtn = document.querySelector('a[href="vault.html"]');
    if (vaultBtn && config.pages) {
      vaultBtn.style.display = config.pages.vaultEnabled !== false ? 'inline-flex' : 'none';
    }

    // 6. Social Links
    if (config.socials) {
      const links = document.querySelectorAll('.social-link');
      links.forEach(link => {
        const text = link.textContent.trim().toLowerCase();
        if (text.includes('discord') && config.socials.discord) {
          link.href = config.socials.discord;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        } else if (text.includes('github') && config.socials.github) {
          link.href = config.socials.github;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
      });
    }

    // 7. Spotify Config Injection
    if (config.spotify && window.applySpotifyWidget) {
      const publicEl = document.getElementById('spotifyPublicConfig');
      if (publicEl) {
        const spotifyPub = {
          enabled: !!config.spotify.enabled,
          clientId: config.spotify.clientId || "",
          refreshToken: config.spotify.refreshToken || ""
        };
        publicEl.textContent = JSON.stringify(spotifyPub, null, 2);
      }
      window.applySpotifyWidget();
    }
  }

  // --- BANNER COMPONENT ---
  function updateLiveBanner(bannerConfig) {
    let banner = document.getElementById('globalLiveBanner');

    if (!bannerConfig || !bannerConfig.enabled || !bannerConfig.text) {
      if (banner) {
        banner.classList.add('banner-hidden');
        setTimeout(() => banner.remove(), 300);
      }
      return;
    }

    if (!banner) {
      injectBannerStyles();
      banner = document.createElement('div');
      banner.id = 'globalLiveBanner';
      banner.className = 'global-live-banner';
      document.body.prepend(banner);
    }

    // Banner type classes
    banner.className = `global-live-banner banner-${bannerConfig.type || 'info'}`;

    const iconMap = {
      info: '⚡',
      success: '✓',
      warning: '⚠️',
      accent: '✦'
    };

    const icon = iconMap[bannerConfig.type] || '⚡';

    banner.innerHTML = `
      <div class="banner-content">
        <span class="banner-icon">${icon}</span>
        <span class="banner-text">${escapeHtml(bannerConfig.text)}</span>
      </div>
      ${bannerConfig.dismissible ? '<button type="button" class="banner-close-btn" onclick="document.getElementById(\'globalLiveBanner\').remove()" title="Dismiss">&times;</button>' : ''}
    `;

    banner.classList.remove('banner-hidden');
  }

  function injectBannerStyles() {
    if (document.getElementById('siteSyncBannerStyles')) return;
    const style = document.createElement('style');
    style.id = 'siteSyncBannerStyles';
    style.textContent = `
      .global-live-banner {
        width: 100%;
        padding: 0.6rem 1.25rem;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        font-size: 0.82rem;
        font-weight: 500;
        z-index: 9999;
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      }
      .banner-hidden {
        transform: translateY(-100%);
        opacity: 0;
        pointer-events: none;
      }
      .banner-content {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        text-align: center;
      }
      .banner-icon {
        font-size: 0.85rem;
      }
      .banner-close-btn {
        position: absolute;
        right: 1rem;
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.6);
        font-size: 1.2rem;
        cursor: pointer;
        padding: 0 0.4rem;
        line-height: 1;
        transition: color 0.15s ease;
      }
      .banner-close-btn:hover {
        color: #ffffff;
      }
      .banner-info {
        background: rgba(14, 165, 233, 0.14);
        border-bottom: 1px solid rgba(14, 165, 233, 0.28);
        color: #e0f2fe;
      }
      .banner-success {
        background: rgba(34, 197, 94, 0.14);
        border-bottom: 1px solid rgba(34, 197, 94, 0.28);
        color: #dcfce7;
      }
      .banner-warning {
        background: rgba(245, 158, 11, 0.14);
        border-bottom: 1px solid rgba(245, 158, 11, 0.28);
        color: #fef3c7;
      }
      .banner-accent {
        background: rgba(120, 119, 198, 0.18);
        border-bottom: 1px solid rgba(120, 119, 198, 0.35);
        color: #f4f4f5;
      }
      .hero-live-subtitle {
        font-size: clamp(0.95rem, 2.2vw, 1.25rem);
        color: var(--text-muted, #a1a1aa);
        font-weight: 400;
        margin-top: 0.85rem;
        max-width: 600px;
        animation: fadeIn 0.3s ease;
      }
      .maintenance-overlay {
        position: fixed;
        inset: 0;
        z-index: 999999;
        background: #09090b;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 2rem;
      }
      .maintenance-badge {
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.1);
        border: 1px solid rgba(245, 158, 11, 0.25);
        padding: 0.3rem 0.8rem;
        border-radius: 9999px;
        margin-bottom: 1.25rem;
      }
      .maintenance-title {
        font-size: clamp(2rem, 5vw, 3.5rem);
        font-weight: 800;
        color: #ffffff;
        letter-spacing: -0.03em;
        margin-bottom: 0.75rem;
      }
      .maintenance-desc {
        color: #a1a1aa;
        max-width: 480px;
        font-size: 0.95rem;
        line-height: 1.5;
      }
    `;
    document.head.appendChild(style);
  }

  function handleMaintenanceMode(pagesConfig) {
    const isMaintenance = !!(pagesConfig && pagesConfig.maintenanceMode);
    const isCurrentAdmin = window.location.pathname.endsWith('admin.html');

    if (isCurrentAdmin) return; // Never lock out admin page!

    let overlay = document.getElementById('siteMaintenanceOverlay');

    if (isMaintenance) {
      if (!overlay) {
        injectBannerStyles();
        overlay = document.createElement('div');
        overlay.id = 'siteMaintenanceOverlay';
        overlay.className = 'maintenance-overlay';
        overlay.innerHTML = `
          <div class="maintenance-badge">Maintenance In Progress</div>
          <h1 class="maintenance-title">We'll be right back</h1>
          <p class="maintenance-desc">${escapeHtml(pagesConfig.maintenanceMessage || "Website is currently undergoing brief maintenance. Please check back soon.")}</p>
        `;
        document.body.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.remove();
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  // --- PUBLIC API ---
  window.SiteSync = {
    getConfig: () => ({ ...currentConfig }),

    applyLiveChanges: (cfg) => {
      currentConfig = deepMerge(currentConfig, cfg);
      localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(currentConfig));
      applyLiveChanges(currentConfig);
    },

    pushLiveUpdate: async (newConfig) => {
      currentConfig = deepMerge(currentConfig, newConfig);
      currentConfig.updatedAt = Date.now();
      localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(currentConfig));
      applyLiveChanges(currentConfig);

      // Push to Firebase Realtime Database
      const fbConfig = getFirebaseConfig();
      if (fbConfig && fbConfig.databaseURL) {
        const cleanUrl = fbConfig.databaseURL.replace(/\/+$/, '');

        // 1. Instant REST write (guaranteed and fast)
        try {
          await fetch(`${cleanUrl}/siteConfig.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentConfig)
          });
        } catch (e) {
          console.warn('[SiteSync] REST write error:', e);
        }

        // 2. Realtime WebSocket SDK write
        await ensureFirebaseLoaded();
        if (window.firebase) {
          try {
            if (!firebaseDb) {
              if (!window.firebase.apps.length) {
                window.firebase.initializeApp(fbConfig);
              }
              firebaseDb = window.firebase.database();
            }
            await firebaseDb.ref('siteConfig').set(currentConfig);
          } catch (e) {
            console.warn('[SiteSync] SDK set error:', e);
          }
        }
        return { success: true, method: 'firebase_rtdb' };
      }

      return { success: true, method: 'local_storage' };
    },

    getFirebaseConfig,
    setFirebaseConfig,
    initFirebaseSync,
    DEFAULT_CONFIG
  };

  // --- AUTO INITIALIZE ON PAGE LOAD ---
  window.addEventListener('DOMContentLoaded', () => {
    currentConfig = getLocalConfig();
    applyLiveChanges(currentConfig);
    initFirebaseSync();
  });

})();

