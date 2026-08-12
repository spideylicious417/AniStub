// ================== DATA LAYER ==================
function loadData() {
  const raw = localStorage.getItem('anistub-data');
  const parsed = raw ? JSON.parse(raw) : {};
  Object.values(parsed).forEach(list => {
    list.categories = list.categories || [];
    list.items = list.items || [];
    list.items.forEach(item => { if (item.categoryId === undefined) item.categoryId = null; });
  });
  return parsed;
}
function saveData() {
  localStorage.setItem('anistub-data', JSON.stringify(data));
}
let data = loadData();
let activeCategoryId = null; // null = show category picker; '__none__' = uncategorized; or a real category id
let currentListId = null;
let activeHistoryCategoryId = null;
let pendingAddBtn = null;
let pendingAnime = null; // anime waiting to be added once a list is chosen

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ================== ANILIST CONFIG ==================
// AniList's GraphQL API needs no key and is what anilist.co itself runs on
// client-side, so it's CORS-friendly. Single POST endpoint for every query.
const ANILIST_URL = 'https://graphql.anilist.co';

const ANIME_FIELDS = `
  id
  title { romaji english }
  coverImage { large }
  averageScore
  seasonYear
  episodes
  status
  nextAiringEpisode { episode }
  genres
  description(asHtml: false)
`;

async function anilistQuery(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || 'AniList error');
  return json.data;
}

// Normalize an AniList media object into the shape renderAnimeGrid expects.
function normalizeAnime(m) {
  // Latest episode actually out: one behind whatever's airing next.
  // For a finished show (no more airing), fall back to its total episode count.
  const latestEpisode = m.nextAiringEpisode && m.nextAiringEpisode.episode > 1
    ? m.nextAiringEpisode.episode - 1
    : (m.status === 'FINISHED' && m.episodes ? m.episodes : null);

  return {
    title: m.title.english || m.title.romaji,
    images: { jpg: { large_image_url: m.coverImage?.large || '' } },
    year: m.seasonYear || null,
    score: m.averageScore ? m.averageScore / 10 : null,
    episodes: m.episodes || null,
    latestEpisode,
    genres: m.genres || [],
    synopsis: (m.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

const animeGrid = document.getElementById('anime-grid');
const discoverSearch = document.getElementById('discover-search');

async function fetchTopAnime() {
  try {
    const data = await anilistQuery(
      `query { Page(page: 1, perPage: 21) { media(type: ANIME, sort: POPULARITY_DESC) { ${ANIME_FIELDS} } } }`
    );
    const list = (data.Page.media || []).map(normalizeAnime);
    if (list.length === 0) {
      animeGrid.innerHTML = '<p class="empty">No anime found.</p>';
      return;
    }
    renderAnimeGrid(animeGrid, list);
    renderCarouselRow(topAiringRow, list.slice(0, 12));
  } catch (err) {
    console.error('fetchTopAnime failed:', err);
    animeGrid.innerHTML = '<p class="empty">Couldn\'t reach AniList — try again in a bit.</p>';
  }
}

async function fetchNewEpisodes() {
  try {
    const data = await anilistQuery(
      `query { Page(page: 1, perPage: 12) { media(type: ANIME, sort: TRENDING_DESC) { ${ANIME_FIELDS} } } }`
    );
    const list = (data.Page.media || []).map(normalizeAnime);
    renderCarouselRow(newEpisodesRow, list);
  } catch (err) {
    console.error('fetchNewEpisodes failed:', err);
    newEpisodesRow.innerHTML = '<p class="empty">Couldn\'t reach AniList — try again in a bit.</p>';
  }
}

// Hero carousel pulls from anime that are CURRENTLY AIRING (status: RELEASING),
// ranked by popularity, instead of the overall most-popular-of-all-time list.
async function fetchHeroAiring() {
  try {
    const data = await anilistQuery(
      `query { Page(page: 1, perPage: 8) { media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) { ${ANIME_FIELDS} } } }`
    );
    const list = (data.Page.media || []).map(normalizeAnime);
    if (list.length === 0) return;
    renderHeroCarousel(list);
  } catch (err) {
    console.error('fetchHeroAiring failed:', err);
  }
}

async function fetchScheduleToday() {
  scheduleContainer.innerHTML = '<p class="empty">Loading today\'s schedule…</p>';
  try {
    const now = Math.floor(Date.now() / 1000);
    const dayStart = now - (now % 86400);
    const dayEnd = dayStart + 86400;
    const data = await anilistQuery(
      `query ($from: Int, $to: Int) {
        Page(page: 1, perPage: 25) {
          airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
            episode
            airingAt
            media { title { romaji english } coverImage { large } }
          }
        }
      }`,
      { from: dayStart, to: dayEnd }
    );
    const schedule = data.Page.airingSchedules || [];
    renderSchedule(schedule);
  } catch (err) {
    console.error('fetchScheduleToday failed:', err);
    scheduleContainer.innerHTML = '<p class="empty">Couldn\'t reach AniList — try again in a bit.</p>';
  }
}

function renderSchedule(schedule) {
  scheduleContainer.innerHTML = '';
  if (schedule.length === 0) {
    scheduleContainer.innerHTML = '<p class="empty">Nothing airing today.</p>';
    return;
  }
  schedule.forEach(entry => {
    const title = entry.media?.title?.english || entry.media?.title?.romaji || 'Unknown';
    const poster = entry.media?.coverImage?.large || '';
    const time = new Date(entry.airingAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const row = document.createElement('div');
    row.className = 'schedule-row';
    row.innerHTML = `
      <div class="schedule-time">${time}</div>
      <div class="schedule-poster">${poster ? `<img src="${poster}" alt="">` : ''}</div>
      <div class="schedule-info">
        <div class="name">${escapeHtml(title)}</div>
        <div class="ep">Episode ${entry.episode}</div>
      </div>`;
    scheduleContainer.appendChild(row);
  });
}
async function searchAnime(query) {
  searchScreenTitle.textContent = `Results for "${query}"`;
  searchGrid.innerHTML = '<p class="empty">Searching…</p>';
  try {
    const data = await anilistQuery(
      `query ($search: String) { Page(page: 1, perPage: 21) { media(type: ANIME, search: $search, sort: SEARCH_MATCH) { ${ANIME_FIELDS} } } }`,
      { search: query }
    );
    const list = (data.Page.media || []).map(normalizeAnime);
    if (list.length === 0) {
      searchGrid.innerHTML = '<p class="empty">No anime found.</p>';
      return;
    }
    renderAnimeGrid(searchGrid, list);
  } catch (err) {
    console.error('searchAnime failed:', err);
    searchGrid.innerHTML = '<p class="empty">Couldn\'t reach AniList — try again in a bit.</p>';
  }
}

function renderAnimeGrid(container, animeList) {
  container.innerHTML = '';
  animeList.forEach(anime => {
    const year = anime.year || (anime.aired && anime.aired.from ? anime.aired.from.slice(0, 4) : '—');
    const poster = anime.images && anime.images.jpg
      ? (anime.images.jpg.large_image_url || anime.images.jpg.image_url)
      : '';
    const rating = anime.score ? anime.score.toFixed(1) : '—';

    const card = document.createElement('div');
    card.className = 'anime-card';
    card.innerHTML = `
      <div class="poster-wrap">
        ${poster ? `<img src="${poster}" alt="${escapeHtml(anime.title)}">` : ''}
        ${anime.latestEpisode ? `<span class="grid-ep-badge">EP ${anime.latestEpisode}</span>` : ''}
      </div>
      <div class="info-panel">
        <div class="info-panel-inner">
          <h3>${escapeHtml(anime.title)}</h3>
          <div class="meta">${year} · ⭐ ${rating}${anime.episodes ? ` · ${anime.episodes} ep` : ''}</div>
          <div class="overview">${escapeHtml(anime.synopsis || '')}</div>
          <button class="add-btn">+ Add</button>
        </div>
      </div>`;

    card.querySelector('.poster-wrap').addEventListener('click', () => {
      const wasOpen = card.classList.contains('open');
      document.querySelectorAll('.anime-card.open').forEach(c => c.classList.remove('open'));
      if (!wasOpen) card.classList.add('open');
    });

    card.querySelector('.add-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      startAddFlow(anime, year, e.target);
    });
    container.appendChild(card);
  });
}

function startAddFlow(anime, year, btnEl) {
  pendingAnime = {
    text: `${anime.title}${year && year !== '—' ? ` (${year})` : ''}`,
    poster: anime.images && anime.images.jpg ? (anime.images.jpg.large_image_url || anime.images.jpg.image_url) : '',
    overview: anime.synopsis || '',
  };
  pendingAddBtn = btnEl || null;
  pushView('chooseList');
}

// ================== HERO CAROUSEL ==================
// Auto-advancing hero banner. Slides are built dynamically from whatever
// anime list is passed in (currently: anime with status RELEASING).
const heroTrack = document.getElementById('hero-track');
const heroDots = document.getElementById('hero-dots');
const HERO_INTERVAL_MS = 6000;
let heroSlidesData = [];
let heroIndex = 0;
let heroTimer = null;

function renderHeroCarousel(animeList) {
  heroSlidesData = animeList;
  heroTrack.innerHTML = '';
  heroDots.innerHTML = '';

  heroSlidesData.forEach((anime, i) => {
    const poster = anime.images && anime.images.jpg ? (anime.images.jpg.large_image_url || anime.images.jpg.image_url) : '';
    const genreLine = (anime.genres || []).slice(0, 6).join(', ');

    const slide = document.createElement('div');
    slide.className = 'hero-slide';
    slide.innerHTML = `
      <div class="hero-media">${poster ? `<img src="${poster}" alt="${escapeHtml(anime.title)}">` : ''}</div>
      <div class="hero-gradient"></div>
      <div class="hero-content">
        <h1>${escapeHtml(anime.title)}</h1>
        <p class="hero-genres">${escapeHtml(genreLine)}</p>
        <div class="hero-actions">
          <button class="btn-primary hero-btn hero-add-btn">▶\u00A0 Add to List</button>
          <button class="btn-outline hero-btn hero-info-btn">+\u00A0 Details</button>
        </div>
        <p class="hero-synopsis" hidden>${escapeHtml(anime.synopsis || '')}</p>
      </div>`;

    slide.querySelector('.hero-add-btn').addEventListener('click', (e) => {
      startAddFlow(anime, anime.year, e.currentTarget);
    });
    slide.querySelector('.hero-info-btn').addEventListener('click', (e) => {
      const synEl = slide.querySelector('.hero-synopsis');
      const willShow = synEl.hidden;
      synEl.hidden = !willShow;
      e.currentTarget.textContent = willShow ? '−\u00A0 Details' : '+\u00A0 Details';
    });
    heroTrack.appendChild(slide);

    const dot = document.createElement('button');
    dot.className = 'hero-dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', `Show slide ${i + 1}`);
    dot.addEventListener('click', () => goToHeroSlide(i));
    heroDots.appendChild(dot);
  });

  heroIndex = 0;
  updateHeroPosition();
  startHeroAutoplay();
}

function updateHeroPosition() {
  heroTrack.style.transform = `translateX(-${heroIndex * 100}%)`;
  heroDots.querySelectorAll('.hero-dot').forEach((d, i) => d.classList.toggle('active', i === heroIndex));
}

function goToHeroSlide(i) {
  heroIndex = i;
  updateHeroPosition();
  startHeroAutoplay(); // restart the timer so it doesn't jump right after a manual pick
}

function startHeroAutoplay() {
  clearInterval(heroTimer);
  if (heroSlidesData.length <= 1) return;
  heroTimer = setInterval(() => {
    heroIndex = (heroIndex + 1) % heroSlidesData.length;
    updateHeroPosition();
  }, HERO_INTERVAL_MS);
}

// ================== CAROUSELS (Top Airing / New Episode Releases) ==================
const topAiringRow = document.getElementById('top-airing-row');
const newEpisodesRow = document.getElementById('new-episodes-row');

function renderCarouselRow(container, animeList) {
  container.innerHTML = '';
  if (animeList.length === 0) {
    container.innerHTML = '<p class="empty">No anime found.</p>';
    return;
  }
  animeList.forEach(anime => {
    const poster = anime.images && anime.images.jpg
      ? (anime.images.jpg.large_image_url || anime.images.jpg.image_url)
      : '';
    const rating = anime.score ? anime.score.toFixed(1) : '—';

    const card = document.createElement('div');
    card.className = 'carousel-card';
    card.innerHTML = `
      <div class="carousel-poster">
        ${poster ? `<img src="${poster}" alt="${escapeHtml(anime.title)}">` : ''}
        <span class="carousel-badge rating">⭐ ${rating}</span>
        ${anime.episodes ? `<span class="carousel-badge episodes">${anime.episodes} EP</span>` : ''}
        <button class="carousel-add-btn" aria-label="Add to list">+</button>
      </div>
      <div class="carousel-title">${escapeHtml(anime.title)}</div>`;

    card.querySelector('.carousel-add-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      startAddFlow(anime, anime.year, e.target);
    });
    container.appendChild(card);
  });
}

// ================== "See all" ==================
document.querySelectorAll('.see-all-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.action === 'new-episodes') {
      showNewEpisodesScreen();
      fetchAllNewEpisodes();
      return;
    }
    const target = document.getElementById(btn.dataset.target);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// ================== SEARCH SCREEN ==================
// Typing a query swaps the whole Home view out for a dedicated results
// screen, instead of scrolling to a grid buried further down the page.
const searchScreen = document.getElementById('search-screen');
const searchGrid = document.getElementById('search-grid');
const searchScreenTitle = document.getElementById('search-screen-title');
const searchBackBtn = document.getElementById('search-back-btn');

function showSearchScreen() {
  homeContent.hidden = true;
  scheduleScreen.hidden = true;
  newEpisodesScreen.hidden = true;
  searchScreen.hidden = false;
}

function hideSearchScreen() {
  searchScreen.hidden = true;
  setActiveTab('home');
}

searchBackBtn.addEventListener('click', () => {
  discoverSearch.value = '';
  searchBarWrap.hidden = true;
  hideSearchScreen();
});

// ================== NEW EPISODE RELEASES (full list) ==================
// "See all" on the New Episode Releases carousel opens its own dedicated
// screen with the full list, rather than jumping into the All Anime grid.
const newEpisodesScreen = document.getElementById('new-episodes-screen');
const newEpisodesGrid = document.getElementById('new-episodes-grid');
const newEpisodesBackBtn = document.getElementById('new-episodes-back-btn');

function showNewEpisodesScreen() {
  homeContent.hidden = true;
  scheduleScreen.hidden = true;
  searchScreen.hidden = true;
  newEpisodesScreen.hidden = false;
}

function hideNewEpisodesScreen() {
  newEpisodesScreen.hidden = true;
  setActiveTab('home');
}

newEpisodesBackBtn.addEventListener('click', hideNewEpisodesScreen);

async function fetchAllNewEpisodes() {
  newEpisodesGrid.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const data = await anilistQuery(
      `query { Page(page: 1, perPage: 21) { media(type: ANIME, sort: TRENDING_DESC) { ${ANIME_FIELDS} } } }`
    );
    const list = (data.Page.media || []).map(normalizeAnime);
    if (list.length === 0) {
      newEpisodesGrid.innerHTML = '<p class="empty">No anime found.</p>';
      return;
    }
    renderAnimeGrid(newEpisodesGrid, list);
  } catch (err) {
    console.error('fetchAllNewEpisodes failed:', err);
    newEpisodesGrid.innerHTML = '<p class="empty">Couldn\'t reach AniList — try again in a bit.</p>';
  }
}

let searchTimer;
discoverSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = discoverSearch.value.trim();
  if (!q) {
    hideSearchScreen();
    return;
  }
  searchTimer = setTimeout(() => {
    showSearchScreen();
    searchAnime(q);
  }, 500);
});

// ================== LIST COLORS ==================
const LIST_COLORS = [
  { hex: '#b5222b' }, { hex: '#c9a227' }, { hex: '#2f9e6f' },
  { hex: '#3b6fd6' }, { hex: '#9b59b6' }, { hex: '#6b7280' },
];
let selectedColor = LIST_COLORS[0].hex;

// ================== ELEMENT REFS ==================
const overlay = document.getElementById('overlay');
const newListModal = document.getElementById('new-list-modal');
const profilePanel = document.getElementById('profile-panel');
const historyPanel = document.getElementById('history-panel');
const notifPanel = document.getElementById('notif-panel');
const topBar = document.getElementById('top-bar');
const homeContent = document.getElementById('home-content');
const scheduleScreen = document.getElementById('schedule-screen');
const scheduleContainer = document.getElementById('schedule-container');
const mylistScreen = document.getElementById('mylist-screen');
const mylistContainer = document.getElementById('mylist-container');
const itemsScreen = document.getElementById('items-screen');
const itemsContainer = document.getElementById('items-container');
const currentListTitle = document.getElementById('current-list-title');
const progressRing = document.getElementById('progress-ring');
const progressFraction = document.getElementById('progress-fraction');
const historyContainer = document.getElementById('history-container');

const profileBtn = document.getElementById('profile-btn');
const searchToggleBtn = document.getElementById('search-toggle-btn');
const searchBarWrap = document.getElementById('search-bar-wrap');
const notifBtn = document.getElementById('notif-btn');
const closeNotifBtn = document.getElementById('close-notif-btn');
const navItems = document.querySelectorAll('.nav-item');
const closeModalBtn = document.getElementById('close-modal-btn');
const cancelListBtn = document.getElementById('cancel-list-btn');
const closePanelBtn = document.getElementById('close-panel-btn');
const createListBtn = document.getElementById('create-list-btn');
const mylistNewListBtn = document.getElementById('mylist-new-list-btn');
const profileMylistShortcutBtn = document.getElementById('profile-mylist-shortcut-btn');
const profileMylistCount = document.getElementById('profile-mylist-count');
const backBtn = document.getElementById('back-btn');
const historyBtn = document.getElementById('history-btn');
const closeHistoryBtn = document.getElementById('close-history-btn');

const listNameInput = document.getElementById('list-name-input');
const listDescInput = document.getElementById('list-desc-input');
const colorPicker = document.getElementById('color-picker');
const modalListsPreview = document.getElementById('modal-lists-preview');

const chooseListModal = document.getElementById('choose-list-modal');
const chooseListOptions = document.getElementById('choose-list-options');
const closeChooseBtn = document.getElementById('close-choose-btn');
const chooseNewListBtn = document.getElementById('choose-new-list-btn');

const confirmDeleteModal = document.getElementById('confirm-delete-modal');
const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

const confirmDeletePoster = document.getElementById('confirm-delete-poster');
const confirmDeleteTitle = document.getElementById('confirm-delete-title');

const categoryBtn = document.getElementById('category-btn');
const categoryModal = document.getElementById('category-modal');
const closeCategoryBtn = document.getElementById('close-category-btn');
const categoryNameInput = document.getElementById('category-name-input');
const addCategoryBtn = document.getElementById('add-category-btn');
const categoryListContainer = document.getElementById('category-list-container');
const categoryListTitle = document.getElementById('category-list-title');

const chooseCategoryModal = document.getElementById('choose-category-modal');
const chooseCategoryOptions = document.getElementById('choose-category-options');
const closeChooseCategoryBtn = document.getElementById('close-choose-category-btn');

const categoryChips = document.getElementById('category-chips');

const historyBackBtn = document.getElementById('history-back-btn');
const historyPanelTitle = document.getElementById('history-panel-title');
const historyChips = document.getElementById('history-chips');

let pendingCategoryListId = null;
let pendingDeleteIndex = null;

// build color swatches
LIST_COLORS.forEach((c, i) => {
  const dot = document.createElement('div');
  dot.className = 'color-dot' + (i === 0 ? ' selected' : '');
  dot.style.background = c.hex;
  dot.textContent = i === 0 ? '✓' : '';
  dot.addEventListener('click', () => {
    selectedColor = c.hex;
    document.querySelectorAll('.color-dot').forEach(d => { d.classList.remove('selected'); d.textContent = ''; });
    dot.classList.add('selected');
    dot.textContent = '✓';
  });
  colorPicker.appendChild(dot);
});

// ================== NAVIGATION (History API) ==================
function applyState(state) {
  const view = (state && state.view) || 'home';

  overlay.hidden = true;
  newListModal.hidden = true;
  chooseListModal.hidden = true;
  profilePanel.hidden = true;
  historyPanel.hidden = true;
  notifPanel.hidden = true;
  itemsScreen.hidden = true;
  topBar.hidden = false;
  homeContent.hidden = false;
  scheduleScreen.hidden = true; // any sheet/dialog reverts the view underneath to Home
  mylistScreen.hidden = true;
  confirmDeleteModal.hidden = true;
  categoryModal.hidden = true;
  chooseCategoryModal.hidden = true;

  if (view === 'profile' || view === 'notif') {
    overlay.hidden = false;
    if (view === 'profile') {
      profilePanel.hidden = false;
      renderProfilePanel();
    } else {
      notifPanel.hidden = false;
    }
  } else if (view === 'mylist') {
    // A full-width tab screen (like Schedule), not a slide-in panel.
    homeContent.hidden = true;
    searchScreen.hidden = true;
    newEpisodesScreen.hidden = true;
    mylistScreen.hidden = false;
    navItems.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === 'mylist'));
    renderMylistScreen();
  } else if (view === 'modal') {
    overlay.hidden = false;
    newListModal.hidden = false;
    renderModalListsPreview();
  } else if (view === 'chooseList') {
    overlay.hidden = false;
    chooseListModal.hidden = false;
    renderChooseListOptions();
  } else if (view === 'category') {
    overlay.hidden = false;
    categoryModal.hidden = false;
    topBar.hidden = true;
    homeContent.hidden = true;
    itemsScreen.hidden = false;
    currentListId = state.id;
    renderItems();
    categoryListTitle.textContent = `Organize "${data[state.id].title}"`;
    renderCategoryList();
  } else if (view === 'chooseCategory') {
    overlay.hidden = false;
    chooseCategoryModal.hidden = false;
    pendingCategoryListId = state.listId;
    renderChooseCategoryOptions();
  } else if (view === 'items') {
    topBar.hidden = true;
    homeContent.hidden = true;
    itemsScreen.hidden = false;
    currentListId = state.id;
    renderItems();
  } else if (view === 'confirmDelete') {
    confirmDeletePoster.innerHTML = state.poster ? `<img src="${state.poster}" alt="">` : '';
    confirmDeleteTitle.textContent = state.title || '';
    overlay.hidden = false;
    confirmDeleteModal.hidden = false;
    topBar.hidden = true;
    homeContent.hidden = true;
    itemsScreen.hidden = false;
    currentListId = state.id;
    renderItems();
    if (state.fromHistory) {
      historyPanel.hidden = false;
      renderHistory();
    }
  } else if (view === 'history') {
    topBar.hidden = true;
    homeContent.hidden = true;
    itemsScreen.hidden = false; // dim behind the panel
    currentListId = state.id;
    renderItems();
    overlay.hidden = false;
    historyPanel.hidden = false;
    renderHistory();
  }

  if (view === 'home') setActiveTab('home');
}

function pushView(view, extra = {}) {
  const state = { view, ...extra };
  history.pushState(state, '');
  applyState(state);
}

window.addEventListener('popstate', (e) => applyState(e.state));

// ================== EVENTS ==================
notifBtn.addEventListener('click', () => pushView('notif'));
closeNotifBtn.addEventListener('click', () => history.back());

searchToggleBtn.addEventListener('click', () => {
  searchBarWrap.hidden = !searchBarWrap.hidden;
  if (!searchBarWrap.hidden) {
    discoverSearch.focus();
  } else {
    discoverSearch.value = '';
    hideSearchScreen();
  }
});

// ================== BOTTOM NAV TABS ==================
function setActiveTab(tab) {
  navItems.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  searchScreen.hidden = true;
  newEpisodesScreen.hidden = true;
  if (tab === 'schedule') {
    homeContent.hidden = true;
    scheduleScreen.hidden = false;
    fetchScheduleToday();
  } else if (tab === 'home') {
    homeContent.hidden = false;
    scheduleScreen.hidden = true;
  }
}

navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab === 'home') {
      setActiveTab('home');
    } else if (tab === 'schedule') {
      setActiveTab('schedule');
    } else if (tab === 'mylist') {
      pushView('mylist');
    } else if (tab === 'profile') {
      setActiveTab('profile');
      pushView('profile');
    }
  });
});
closeModalBtn.addEventListener('click', () => history.back());
cancelListBtn.addEventListener('click', () => history.back());
closePanelBtn.addEventListener('click', () => history.back());
overlay.addEventListener('click', () => history.back());
profileMylistShortcutBtn.addEventListener('click', () => {
  pushView('mylist');
});
mylistNewListBtn.addEventListener('click', () => pushView('modal'));
backBtn.addEventListener('click', () => {
  const list = data[currentListId];
  if (list && list.categories.length > 0 && activeCategoryId !== null) {
    activeCategoryId = null; // step back to the category picker, don't leave the list
    renderItems();
  } else {
    history.back();
  }
});
historyBtn.addEventListener('click', () => {
  activeHistoryCategoryId = null;
  pushView('history', { id: currentListId });
});
historyBackBtn.addEventListener('click', () => {
  activeHistoryCategoryId = null;
  renderHistory();
});
closeHistoryBtn.addEventListener('click', () => history.back());
closeChooseBtn.addEventListener('click', () => { pendingAnime = null; history.back(); });
chooseNewListBtn.addEventListener('click', () => pushView('modal'));
categoryBtn.addEventListener('click', () => pushView('category', { id: currentListId }));
closeCategoryBtn.addEventListener('click', () => history.back());

// ================== LIST CRUD ==================
function createList(title, description, color) {
  const id = crypto.randomUUID();
  data[id] = { title, description: description || '', color, items: [], categories: [] };
  saveData();
  return id;
}

createListBtn.addEventListener('click', () => {
  const title = listNameInput.value.trim();
  if (!title) { listNameInput.focus(); return; }
  const newId = createList(title, listDescInput.value.trim(), selectedColor);
  listNameInput.value = '';
  listDescInput.value = '';

  if (pendingAnime) {
    addItemToList(newId, pendingAnime);
    markAdded(pendingAddBtn);
    pendingAnime = null;
    pendingAddBtn = null;
    history.go(-2); // skip past the chooseList sheet back to the grid
  } else {
    history.back();
  }
});

closeChooseCategoryBtn.addEventListener('click', () => {
  pendingAnime = null;
  pendingCategoryListId = null;
  history.back();
});

addCategoryBtn.addEventListener('click', () => {
  const name = categoryNameInput.value.trim();
  if (!name) { categoryNameInput.focus(); return; }
  addCategory(currentListId, name);
  categoryNameInput.value = '';
  renderCategoryList();
  renderItems();
});

function buildTicketCard(id) {
  const list = data[id];
  const count = list.items.length;
  const passNum = String(Object.keys(data).indexOf(id) + 1).padStart(3, '0');

  const card = document.createElement('div');
  card.className = 'ticket-list-card';
  card.innerHTML = `
    <div class="ticket-list-main">
      <div class="ticket-list-icon" style="background:${list.color}33; color:${list.color}">📺</div>
      <div class="ticket-list-info">
        <div class="name">${escapeHtml(list.title)}</div>
        ${list.description ? `<div class="desc">${escapeHtml(list.description)}</div>` : ''}
      </div>
      <div class="ticket-list-count">${count}</div>
    </div>
    <div class="ticket-list-footer">PASS ${passNum} · ANISTUB</div>`;

  card.querySelector('.ticket-list-main').addEventListener('click', () => {
    activeCategoryId = null;
    pushView('items', { id });
  });
  return card;
}

// Profile panel: identity + a shortcut card that shows how many lists exist
function renderProfilePanel() {
  const total = Object.keys(data).length;
  profileMylistCount.textContent = total === 0
    ? 'No lists yet'
    : `${total} list${total === 1 ? '' : 's'}`;
}

function renderMylistScreen() {
  mylistContainer.innerHTML = '';
  const ids = Object.keys(data);
  if (ids.length === 0) { mylistContainer.innerHTML = '<p class="empty">No lists yet — tap "+ New list" to start one.</p>'; return; }
  ids.forEach(id => mylistContainer.appendChild(buildTicketCard(id)));
}

function renderModalListsPreview() {
  modalListsPreview.innerHTML = '';
  const ids = Object.keys(data);
  if (ids.length === 0) { modalListsPreview.innerHTML = '<p class="empty">No lists yet.</p>'; return; }
  ids.forEach(id => modalListsPreview.appendChild(buildTicketCard(id)));
}

function renderCategoryList() {
  categoryListContainer.innerHTML = '';
  const list = data[currentListId];
  if (list.categories.length === 0) {
    categoryListContainer.innerHTML = '<p class="empty">No categories yet.</p>';
    return;
  }
  list.categories.forEach(cat => {
    const count = list.items.filter(i => i.categoryId === cat.id).length;
    const row = document.createElement('div');
    row.className = 'category-row';
    row.innerHTML = `
      <div class="name">${escapeHtml(cat.name)} <span>(${count})</span></div>
      <button class="remove-category-btn" aria-label="Remove category">✕</button>`;
    row.querySelector('.remove-category-btn').addEventListener('click', () => {
      removeCategory(currentListId, cat.id);
      renderCategoryList();
      renderItems();
    });
    categoryListContainer.appendChild(row);
  });
}

function markAdded(btn) {
  if (!btn) return;
  btn.classList.add('added');
  if (btn.classList.contains('carousel-add-btn')) {
    btn.textContent = '✓';
  } else if (btn.classList.contains('hero-btn')) {
    btn.textContent = '✓\u00A0 Added';
  } else {
    btn.textContent = '✓ Added';
  }
}

function finishAdd(steps = 1) {
  markAdded(pendingAddBtn);
  pendingAnime = null;
  pendingAddBtn = null;
  history.go(-steps);
}

function renderChooseCategoryOptions() {
  chooseCategoryOptions.innerHTML = '';
  const list = data[pendingCategoryListId];

  const noneRow = document.createElement('div');
  noneRow.className = 'choose-list-option';
  noneRow.innerHTML = `<div class="icon" style="background:#3a364033; color:#a39d8f">—</div><div class="name">No category</div>`;
  noneRow.addEventListener('click', () => {
    addItemToList(pendingCategoryListId, pendingAnime, null);
    finishAdd(2);
  });
  chooseCategoryOptions.appendChild(noneRow);

  list.categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'choose-list-option';
    row.innerHTML = `<div class="icon" style="background:#c9a22733; color:#c9a227">🏷</div><div class="name">${escapeHtml(cat.name)}</div>`;
    row.addEventListener('click', () => {
      addItemToList(pendingCategoryListId, pendingAnime, cat.id);
      finishAdd(2);
    });
    chooseCategoryOptions.appendChild(row);
  });
}

function renderChooseListOptions() {
  chooseListOptions.innerHTML = '';
  const ids = Object.keys(data);

  if (ids.length === 0) {
    chooseListOptions.innerHTML = '<p class="empty">No lists yet — create one below.</p>';
    return;
  }

  ids.forEach(id => {
    const list = data[id];
    const row = document.createElement('div');
    row.className = 'choose-list-option';
    row.innerHTML = `
      <div class="icon" style="background:${list.color}33; color:${list.color}">📺</div>
      <div class="name">${escapeHtml(list.title)}</div>
      <div class="count">${list.items.length}</div>`;

    row.addEventListener('click', () => {
      if (list.categories.length > 0) {
        pushView('chooseCategory', { listId: id });
      } else {
        addItemToList(id, pendingAnime, null);
        finishAdd(1);
      }
    });

    chooseListOptions.appendChild(row);
  });
}

// ================== ITEM CRUD ==================
function addItemToList(listId, anime, categoryId = null) {
  data[listId].items.push({
    text: anime.text,
    poster: anime.poster || '',
    overview: anime.overview || '',
    done: false,
    categoryId: categoryId || null,
  });
  saveData();
}

function addCategory(listId, name) {
  const list = data[listId];
  list.categories.push({ id: crypto.randomUUID(), name });
  saveData();
}
function removeCategory(listId, categoryId) {
  const list = data[listId];
  list.categories = list.categories.filter(c => c.id !== categoryId);
  list.items.forEach(i => { if (i.categoryId === categoryId) i.categoryId = null; });
  saveData();
}

function buildAnimeItemCard(item, index) {
  const row = document.createElement('div');
  row.className = 'anime-item-card';
  row.innerHTML = `
    <div class="swipe-area">
      <button class="delete-btn" aria-label="Delete">🗑</button>
      <div class="stub-body">
        <div class="anime-item-poster">${item.poster ? `<img src="${item.poster}" alt="">` : ''}</div>
        <div class="stub-tear"><span class="tear-label">ADMIT ONE</span></div>
        <div class="anime-item-info">
          <div class="anime-item-title">${escapeHtml(item.text)}</div>
          <div class="anime-item-desc">${escapeHtml(item.overview || '')}</div>
        </div>
      </div>
    </div>
    <button class="check-circle ${item.done ? 'checked' : ''}">${item.done ? '✓' : ''}</button>`;

  row.querySelector('.stub-body').addEventListener('click', () => {
    const wasOpen = row.classList.contains('menu-open');
    document.querySelectorAll('.anime-item-card.menu-open').forEach(c => c.classList.remove('menu-open'));
    if (!wasOpen) row.classList.add('menu-open');
  });

  row.querySelector('.check-circle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleItem(index);
  });

  row.querySelector('.delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    pendingDeleteIndex = index;
    pushView('confirmDelete', {
      id: currentListId,
      fromHistory: !historyPanel.hidden,
      poster: item.poster,
      title: item.text,
    });
  });
  return row;
}

cancelDeleteBtn.addEventListener('click', () => {
  pendingDeleteIndex = null;
  history.back();
});

confirmDeleteBtn.addEventListener('click', () => {
  data[currentListId].items.splice(pendingDeleteIndex, 1);
  saveData();
  pendingDeleteIndex = null;
  history.back(); // closes the confirm sheet
  renderItems();
  if (!historyPanel.hidden) renderHistory();
});

// close any open delete menu when tapping elsewhere
document.addEventListener('click', (e) => {
  if (!e.target.closest('.anime-item-card')) {
    document.querySelectorAll('.anime-item-card.menu-open').forEach(c => c.classList.remove('menu-open'));
  }
});

// ================== ITEMS SCREEN ==================
function renderItems() {
  const list = data[currentListId];
  currentListTitle.textContent = list.title;
  itemsContainer.innerHTML = '';
  categoryChips.hidden = true;

  const total = list.items.length;
  const doneCount = list.items.filter(i => i.done).length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  progressRing.style.setProperty('--pct', pct);
  progressFraction.textContent = `${doneCount}/${total} watched`;

  if (total === 0) {
    itemsContainer.innerHTML = '<p class="empty">No anime yet — add some from the Anime tab.</p>';
    return;
  }

  if (list.categories.length === 0) {
    renderFlatItems(list);
    return;
  }

  if (activeCategoryId === null) {
    renderCategoryPicker(list);
  } else {
    categoryChips.hidden = false;
    renderCategoryChips(list);
    renderFilteredItems(list, activeCategoryId);
  }
}

function renderFlatItems(list) {
  const toWatch = list.items
    .map((item, index) => ({ item, index }))
    .filter(entry => !entry.item.done);

  if (toWatch.length === 0) {
    itemsContainer.innerHTML = '<p class="empty">All caught up! Check your Watched history 🕐</p>';
    return;
  }
  toWatch.forEach(({ item, index }) => itemsContainer.appendChild(buildAnimeItemCard(item, index)));
}

function renderCategoryPicker(list) {
  list.categories.forEach(cat => {
    const count = list.items.filter(i => i.categoryId === cat.id && !i.done).length;
    const btn = document.createElement('button');
    btn.className = 'category-picker-btn';
    btn.innerHTML = `<span>${escapeHtml(cat.name)}</span>${count ? `<span class="pill-count">${count}</span>` : ''}`;
    btn.addEventListener('click', () => { activeCategoryId = cat.id; renderItems(); });
    itemsContainer.appendChild(btn);
  });

  const uncategorizedCount = list.items.filter(i => i.categoryId === null && !i.done).length;
  if (uncategorizedCount > 0) {
    const btn = document.createElement('button');
    btn.className = 'category-picker-btn muted';
    btn.innerHTML = `<span>Uncategorized</span><span class="pill-count">${uncategorizedCount}</span>`;
    btn.addEventListener('click', () => { activeCategoryId = '__none__'; renderItems(); });
    itemsContainer.appendChild(btn);
  }
}

function renderCategoryChips(list) {
  categoryChips.innerHTML = '';
  list.categories.forEach(cat => {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (cat.id === activeCategoryId ? ' active' : '');
    chip.textContent = cat.name;
    chip.addEventListener('click', () => { activeCategoryId = cat.id; renderItems(); });
    categoryChips.appendChild(chip);
  });

  const uncategorizedCount = list.items.filter(i => i.categoryId === null).length;
  if (uncategorizedCount > 0) {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (activeCategoryId === '__none__' ? ' active' : '');
    chip.textContent = 'Uncategorized';
    chip.addEventListener('click', () => { activeCategoryId = '__none__'; renderItems(); });
    categoryChips.appendChild(chip);
  }
}

function renderFilteredItems(list, categoryId) {
  const toWatch = list.items
    .map((item, index) => ({ item, index }))
    .filter(entry => !entry.item.done)
    .filter(entry => categoryId === '__none__' ? entry.item.categoryId === null : entry.item.categoryId === categoryId);

  if (toWatch.length === 0) {
    itemsContainer.innerHTML = '<p class="empty">Nothing here yet.</p>';
    return;
  }
  toWatch.forEach(({ item, index }) => itemsContainer.appendChild(buildAnimeItemCard(item, index)));
}

function toggleItem(index) {
  data[currentListId].items[index].done = !data[currentListId].items[index].done;
  saveData();
  renderItems();
  if (!historyPanel.hidden) renderHistory();
}

// ================== HISTORY PANEL ==================
function renderHistory() {
  const list = data[currentListId];
  historyContainer.innerHTML = '';
  historyChips.hidden = true;
  historyBackBtn.hidden = true;
  historyPanelTitle.textContent = 'Watched';

  const watched = list.items
    .map((item, index) => ({ item, index }))
    .filter(entry => entry.item.done);

  if (watched.length === 0) {
    historyContainer.innerHTML = '<p class="empty">Nothing watched yet.</p>';
    return;
  }

  if (list.categories.length === 0) {
    watched.forEach(({ item, index }) => historyContainer.appendChild(buildAnimeItemCard(item, index)));
    return;
  }

  if (activeHistoryCategoryId === null) {
    renderHistoryCategoryPicker(list, watched);
  } else {
    historyBackBtn.hidden = false;
    const activeCat = list.categories.find(c => c.id === activeHistoryCategoryId);
    historyPanelTitle.textContent = activeCat ? activeCat.name : 'Uncategorized';
    historyChips.hidden = false;
    renderHistoryChips(list, watched);
    renderFilteredHistory(watched, activeHistoryCategoryId);
  }
}

function renderHistoryCategoryPicker(list, watched) {
  list.categories.forEach(cat => {
    const count = watched.filter(({ item }) => item.categoryId === cat.id).length;
    if (count === 0) return;
    const btn = document.createElement('button');
    btn.className = 'category-picker-btn';
    btn.innerHTML = `<span>${escapeHtml(cat.name)}</span><span class="pill-count">${count}</span>`;
    btn.addEventListener('click', () => { activeHistoryCategoryId = cat.id; renderHistory(); });
    historyContainer.appendChild(btn);
  });

  const uncategorizedCount = watched.filter(({ item }) => item.categoryId === null).length;
  if (uncategorizedCount > 0) {
    const btn = document.createElement('button');
    btn.className = 'category-picker-btn muted';
    btn.innerHTML = `<span>Uncategorized</span><span class="pill-count">${uncategorizedCount}</span>`;
    btn.addEventListener('click', () => { activeHistoryCategoryId = '__none__'; renderHistory(); });
    historyContainer.appendChild(btn);
  }
}

function renderHistoryChips(list, watched) {
  historyChips.innerHTML = '';
  list.categories.forEach(cat => {
    if (!watched.some(({ item }) => item.categoryId === cat.id)) return;
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (cat.id === activeHistoryCategoryId ? ' active' : '');
    chip.textContent = cat.name;
    chip.addEventListener('click', () => { activeHistoryCategoryId = cat.id; renderHistory(); });
    historyChips.appendChild(chip);
  });

  if (watched.some(({ item }) => item.categoryId === null)) {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (activeHistoryCategoryId === '__none__' ? ' active' : '');
    chip.textContent = 'Uncategorized';
    chip.addEventListener('click', () => { activeHistoryCategoryId = '__none__'; renderHistory(); });
    historyChips.appendChild(chip);
  }
}

function renderFilteredHistory(watched, categoryId) {
  const filtered = watched.filter(({ item }) =>
    categoryId === '__none__' ? item.categoryId === null : item.categoryId === categoryId
  );
  if (filtered.length === 0) {
    historyContainer.innerHTML = '<p class="empty">Nothing here yet.</p>';
    return;
  }
  filtered.forEach(({ item, index }) => historyContainer.appendChild(buildAnimeItemCard(item, index)));
}

// ================== INIT ==================
history.replaceState({ view: 'home' }, '');
fetchTopAnime();
fetchNewEpisodes();
fetchHeroAiring();