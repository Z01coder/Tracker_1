/**
 * «Дейлик» — логика приложения (этап 2, MVP).
 *
 * Архитектура: один объект состояния (массив задач) + полная перерисовка
 * списков после каждого действия. Узлы карточек кэшируются по id задачи
 * (cardCache) и переиспользуются — это и убирает лишние перерисовки,
 * и готовит почву для анимаций этапа 3 (FLIP-анимация перемещения
 * требует сохранения узла между рендерами).
 *
 * Данные хранятся в localStorage: при недоступности localStorage
 * (приватный режим/запрет cookies) приложение работает в памяти —
 * данные живут до перезагрузки страницы.
 *
 * Анимации: узлы карточек кэшируются, поэтому перемещения между
 * секциями и внутри списка анимируются по FLIP-схеме (First-Last-
 * Invert-Play): запоминаем позиции до рендера, после рендера считаем
 * сдвиг и проигрываем переход. Новые карточки влетают keyframes'ом
 * (card-enter), удаляемые схлопываются (is-leaving).
 */

'use strict';

/* ===================== Константы ===================== */

// Ключи localStorage (v1 — версия схемы данных)
const STORAGE_KEY = 'daytracker.tasks.v1';
const LAST_VISIT_KEY = 'daytracker.lastVisit.v1';

// Порядок сортировки активных задач: высокий приоритет — выше
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABELS = { low: 'низкий', medium: 'средний', high: 'высокий' };

/* ===================== Состояние ===================== */

let tasks = [];                 // все задачи (активные, выполненные, история)
let editingId = null;           // id задачи, открытой в модалке (null = создание)
let quickPriority = 'medium';   // приоритет, выбранный точками быстрого добавления
let showDone = false;           // развёрнута ли секция «Выполнено сегодня»
let showHistory = false;        // развёрнута ли секция «Ранние дни»

const cardCache = new Map();    // id задачи -> DOM-узел карточки (переиспользуем при рендере)
const pendingEnter = new Set(); // id только что созданных задач: первая отрисовка — с анимацией появления
const pendingDelete = new Set();// id удаляемых задач: узел уходит с анимацией, потом удаляется из DOM

/** Уважает настройку пользователя «меньше движения». */
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ===================== Утилиты ===================== */

/** Сегодняшняя дата в формате YYYY-MM-DD по ЛОКАЛЬНОМУ времени
 *  (toISOString() даёт UTC и у границ суток ошибается на часовых поясах). */
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** «3 ноября» — дата для шапки. */
function formatDateRu(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(y, m - 1, d));
}

/** Уникальный id задачи: timestamp + случайный хвост. */
function uid() {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ===================== Хранилище ===================== */

/** Проверяем доступность localStorage (может быть запрещён в приватном режиме). */
function detectStorage() {
  try {
    const probe = '__daylik_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

const storageOK = detectStorage();

// Запасное хранилище в памяти: приложение не падает без localStorage,
// но данные живут только до перезагрузки страницы
const memoryStore = {};

function readStore(key) {
  if (!storageOK) return memoryStore[key] ?? null;
  return localStorage.getItem(key);
}

function writeStore(key, value) {
  if (!storageOK) { memoryStore[key] = value; return; }
  localStorage.setItem(key, value);
}

/** Загружаем задачи из localStorage; если ключа нет — сеем демо-данные
 *  (первый запуск не должен выглядеть пустым). */
function loadTasks() {
  const raw = readStore(STORAGE_KEY);
  if (raw === null) {
    tasks = seedDemoTasks();
    saveTasks();
    return;
  }
  try {
    tasks = JSON.parse(raw);
    if (!Array.isArray(tasks)) tasks = [];
  } catch {
    // повреждённый JSON — начинаем с чистого листа, а не с падения приложения
    console.warn('Не удалось прочитать сохранённые задачи, начинаем с пустого списка');
    tasks = [];
  }
}

function saveTasks() {
  writeStore(STORAGE_KEY, JSON.stringify(tasks));
}

/* ===================== Демо-данные ===================== */

/** 7 живых задач на сегодня: 5 активных с разными приоритетами и временем,
 *  2 выполненные. Вызываются только при самом первом запуске. */
function seedDemoTasks() {
  const today = todayStr();
  const hourAgo = (h) => Date.now() - h * 60 * 60 * 1000;
  return [
    {
      id: uid(), title: 'Утренняя зарядка', note: '', date: today,
      status: 'done', priority: 'low', time: '', createdAt: hourAgo(6),
      completedAt: hourAgo(5), transferred: false,
    },
    {
      id: uid(), title: 'Разобрать входящую почту', note: 'Ответить на письмо про счёт', date: today,
      status: 'done', priority: 'medium', time: '', createdAt: hourAgo(5.5),
      completedAt: hourAgo(4), transferred: false,
    },
    {
      id: uid(), title: 'Созвон по учебному проекту', note: 'Подготовить повестку', date: today,
      status: 'active', priority: 'high', time: '10:00', createdAt: hourAgo(5),
      completedAt: null, transferred: false,
    },
    {
      id: uid(), title: 'Отправить отчёт заказчику', note: 'Финальная версия после правок', date: today,
      status: 'active', priority: 'high', time: '', createdAt: hourAgo(4.5),
      completedAt: null, transferred: false,
    },
    {
      id: uid(), title: 'Купить продукты', note: 'Молоко, яйца, хлеб, кофе', date: today,
      status: 'active', priority: 'medium', time: '', createdAt: hourAgo(3),
      completedAt: null, transferred: false,
    },
    {
      id: uid(), title: 'Тренировка: лёгкий бег', note: '', date: today,
      status: 'active', priority: 'medium', time: '18:30', createdAt: hourAgo(2),
      completedAt: null, transferred: false,
    },
    {
      id: uid(), title: 'Дочитать главу книги', note: '', date: today,
      status: 'active', priority: 'low', time: '', createdAt: hourAgo(1),
      completedAt: null, transferred: false,
    },
  ];
}

/* ===================== Смена дня ===================== */

/** Автоперенос: если даты последнего визита и сегодня различаются,
 *  все невыполненные задачи прошлых дней переезжают на сегодня
 *  с пометкой «перенесена». Выполненные остаются в истории. */
function handleDayRollover() {
  const today = todayStr();
  const lastVisit = readStore(LAST_VISIT_KEY);
  let changed = false;

  if (lastVisit && lastVisit !== today) {
    for (const t of tasks) {
      if (t.status === 'active' && t.date < today) {
        t.date = today;
        t.transferred = true;
        changed = true;
      }
    }
  }

  writeStore(LAST_VISIT_KEY, today);
  if (changed) saveTasks();
}

/* ===================== Выборки для рендера ===================== */

const today = () => todayStr();

// Активные задачи сегодня, отсортированные по приоритету,
// внутри уровня — по времени добавления
function getActiveToday() {
  return tasks
    .filter((t) => t.status === 'active' && t.date === today())
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt);
}

// Выполненные сегодня (для секции «Выполнено»)
function getDoneToday() {
  return tasks
    .filter((t) => t.status === 'done' && t.date === today())
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}

// Выполненные в прошлые дни (история), сгруппированные по дате
function getHistoryGroups() {
  const byDate = new Map();
  for (const t of tasks) {
    if (t.status === 'done' && t.date < today()) {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    }
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // свежие даты сверху
    .map(([date, list]) => ({ date, list }));
}

/* ===================== Рендер ===================== */

const $ = (sel) => document.querySelector(sel);

/** Единая точка перерисовки. После каждого действия вызываем только её.
 *  FLIP: до перерисовки снимаем позиции карточек, после — проигрываем
 *  сдвиги для тех, кто переместился. */
function renderAll() {
  const prevPositions = snapshotPositions();
  renderAllNow();
  playFlip(prevPositions);
}

/** Позиции всех видимых кэшированных карточек (для FLIP). */
function snapshotPositions() {
  const map = new Map();
  if (prefersReducedMotion()) return map;
  cardCache.forEach((el, id) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0) map.set(id, r);
  });
  return map;
}

/** FLIP-проигрывание: карточка сначала «встаёт» на старое место
 *  (transform), затем пружинно возвращается в новую позицию. */
function playFlip(prevPositions) {
  if (prefersReducedMotion()) return;
  cardCache.forEach((el, id) => {
    const prev = prevPositions.get(id);
    if (!prev) return;
    const now = el.getBoundingClientRect();
    if (now.width === 0) return; // переехала в скрытую секцию — не анимируем
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 0.38s var(--spring)';
      el.style.transform = '';
      // подчистим инлайн-стили после проигрывания
      setTimeout(() => { el.style.transition = ''; el.style.transform = ''; }, 420);
    });
  });
}

/** Внутренняя перерисовка без FLIP (вызывается только из renderAll). */
function renderAllNow() {
  const activeList = getActiveToday();
  const doneList = getDoneToday();
  const historyGroups = getHistoryGroups();

  // Шапка и дата
  $('#appDate').textContent = `Сегодня, ${formatDateRu(today())}`;

  // Прогресс дня: считаем по всем задачам сегодняшнего дня
  const totalToday = activeList.length + doneList.length;
  const doneToday = doneList.length;
  const percent = totalToday === 0 ? 0 : Math.round((doneToday / totalToday) * 100);
  $('#progressLabel').textContent = `Выполнено ${doneToday} из ${totalToday}`;
  $('#progressPercent').textContent = `${percent}%`;
  $('#progressBar').style.width = `${percent}%`;

  // Активный список + пустое состояние
  syncSection($('#activeList'), activeList);
  $('#emptyState').hidden = activeList.length > 0;

  // «Выполнено сегодня»: счётчик, кнопка очистки, развёртка
  $('#doneCount').textContent = String(doneList.length);
  $('#clearDoneBtn').hidden = doneList.length === 0;
  $('#doneToggle').setAttribute('aria-expanded', String(showDone));
  $('#doneList').hidden = !showDone;
  syncSection($('#doneList'), doneList);

  // «Ранние дни»: сворачиваем/разворачиваем, заполняем группами по датам
  const historyCount = historyGroups.reduce((sum, g) => sum + g.list.length, 0);
  $('#historyCount').textContent = String(historyCount);
  $('#historyToggle').setAttribute('aria-expanded', String(showHistory));
  syncHistory(historyGroups);
}

/** Синхронизация контейнера со списком задач: узлы кэшируются по id,
 *  переиспользуются и расставляются appendChild'ем в нужном порядке.
 *  Так один и тот же узел плавно «переезжает» между секциями
 *  (активные -> выполненные), не теряя идентичности. */
function syncSection(container, list) {
  const seen = new Set();
  for (const task of list) {
    seen.add(task.id);
    let el = cardCache.get(task.id);
    if (!el) {
      el = buildCard(task);
      cardCache.set(task.id, el);
    } else {
      updateCard(el, task);
    }
    container.appendChild(el); // перенос узла = смена секции или позиции
  }
  // Удаляем узлы задач, которых в этом контейнере больше нет
  for (const child of [...container.children]) {
    const id = child.dataset.id;
    if (!seen.has(id)) {
      if (cardCache.get(id) === child) cardCache.delete(id);
      if (pendingDelete.has(id) && !prefersReducedMotion()) {
        // Анимированное удаление: затухание + схлопывание высоты, потом remove
        pendingDelete.delete(id);
        child.classList.add('is-leaving');
        child.style.maxHeight = `${child.offsetHeight}px`;
        requestAnimationFrame(() => { child.style.maxHeight = '0px'; });
        const removeEl = () => child.remove();
        child.addEventListener('transitionend', removeEl, { once: true });
        setTimeout(removeEl, 450); // страховка: transitionend может не прийти
      } else {
        child.remove();
      }
    }
  }
}

/** История «Ранних дней»: группы по датам. Пересобираем целиком —
 *  секция свёрнута по умолчанию и перерисовывается редко. */
function syncHistory(groups) {
  const container = $('#historyList');
  container.textContent = '';
  for (const group of groups) {
    const heading = document.createElement('p');
    heading.className = 'history-date';
    // «выполнено 2 ноября» — даты прошлых дней
    heading.textContent = formatDateRu(group.date);
    container.appendChild(heading);
    const wrap = document.createElement('div');
    wrap.className = 'task-list';
    syncSection(wrap, group.list);
    container.appendChild(wrap);
  }
}

/** Создаём карточку задачи. Пользовательский текст вставляем через
 *  textContent — XSS через название/заметку невозможен. */
function buildCard(task) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = task.id;
  card.innerHTML = `
    <button class="card-check" type="button" aria-label="Отметить выполненной"></button>
    <div class="card-body">
      <div class="card-title"></div>
      <div class="card-note" hidden></div>
      <div class="card-meta">
        <span class="badge badge-priority"></span>
        <span class="badge badge-time" hidden></span>
        <span class="badge badge-transferred" hidden>перенесена</span>
      </div>
    </div>
    <div class="card-actions">
      <button class="btn btn-ghost btn-small act-edit" type="button">Изменить</button>
      <button class="btn btn-ghost btn-small act-delete" type="button">Удалить</button>
    </div>`;

  // Готовые элементы достаём один раз и заполняем в updateCard()
  card._title = card.querySelector('.card-title');
  card._note = card.querySelector('.card-note');
  card._prio = card.querySelector('.badge-priority');
  card._time = card.querySelector('.badge-time');
  card._transferred = card.querySelector('.badge-transferred');

  // Только что созданная задача влетает с анимацией появления
  if (pendingEnter.has(task.id)) {
    pendingEnter.delete(task.id);
    card.classList.add('card-enter');
    card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
  }

  card.querySelector('.card-check').addEventListener('click', () => toggleDone(task.id));
  card.querySelector('.act-edit').addEventListener('click', () => openModal(task.id));
  card.querySelector('.act-delete').addEventListener('click', () => deleteTask(task.id));

  updateCard(card, task);
  return card;
}

/** Обновляем содержимое существующей карточки (переиспользование узла). */
function updateCard(card, task) {
  card.classList.toggle('is-done', task.status === 'done');
  card.querySelector('.card-check').setAttribute(
    'aria-label',
    task.status === 'done' ? 'Вернуть в активные' : 'Отметить выполненной'
  );

  card._title.textContent = task.title;
  card._note.textContent = task.note;
  card._note.hidden = !task.note;

  card._prio.textContent = PRIORITY_LABELS[task.priority];
  card.dataset.priority = task.priority; // стили приоритетов цепляются к data-атрибуту

  card._time.textContent = task.time || '';
  card._time.hidden = !task.time;
  card._transferred.hidden = !task.transferred;
}

/* ===================== Действия ===================== */

/** Быстрое добавление: только название + выбранный приоритет. */
function quickAdd(title) {
  const task = {
    id: uid(),
    title,
    note: '',
    date: today(),
    status: 'active',
    priority: quickPriority,
    time: '',
    createdAt: Date.now(),
    completedAt: null,
    transferred: false,
  };
  pendingEnter.add(task.id); // первая отрисовка — с анимацией появления
  tasks.push(task);
  saveTasks();
  renderAll();
}

/** Отметить выполненной / вернуть в активные. */
function toggleDone(id) {
  const t = tasks.find((t) => t.id === id);
  if (!t) return;
  const marking = t.status === 'active';
  if (marking) {
    t.status = 'done';
    t.completedAt = Date.now();
  } else {
    t.status = 'active';
    t.completedAt = null;
  }

  const el = cardCache.get(id);
  if (marking && !showDone && el && !prefersReducedMotion()) {
    // Секция «Выполнено» свёрнута: карточка «улетает» в счётчик —
    // сжимается на месте, затем молча переезжает в скрытый список
    el.classList.add('is-done', 'is-leaving');
    el.style.maxHeight = `${el.offsetHeight}px`;
    requestAnimationFrame(() => { el.style.maxHeight = '0px'; });
    setTimeout(() => {
      el.classList.remove('is-leaving');
      el.style.maxHeight = '';
      saveTasks();
      renderAll();
    }, 300);
  } else {
    if (!marking && el && !prefersReducedMotion()) {
      // Возврат из свёрнутой секции: карточка появляется с мягким scale
      el.classList.add('card-return');
      el.addEventListener('animationend', () => el.classList.remove('card-return'), { once: true });
    }
    saveTasks();
    renderAll();
  }
}

/** Удалить задачу совсем (узел уходит с анимацией — см. syncSection). */
function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  pendingDelete.add(id);
  saveTasks();
  renderAll();
}

/** Очистить выполненные за сегодня (история прошлых дней не трогается). */
function clearDone() {
  tasks = tasks.filter((t) => !(t.status === 'done' && t.date === today()));
  saveTasks();
  renderAll();
}

/* ===================== Модальное окно ===================== */

const modal = $('#taskModal');

/** Открыть модалку: с id — редактирование, без — создание «с деталями». */
function openModal(id = null) {
  editingId = id;
  const task = id ? tasks.find((t) => t.id === id) : null;

  $('#modalTitle').textContent = task ? 'Редактирование задачи' : 'Новая задача';
  $('#taskTitle').value = task ? task.title : '';
  $('#taskNote').value = task ? task.note : '';
  $('#taskTime').value = task ? (task.time || '') : '';
  const prio = task ? task.priority : quickPriority;
  modal.querySelector(`input[name="priority"][value="${prio}"]`).checked = true;

  modal.showModal();
  $('#taskTitle').focus();
}

/** Сохранение модалки: создаём новую задачу или обновляем существующую. */
function saveModal() {
  const title = $('#taskTitle').value.trim();
  if (!title) {
    // мягкая валидация: пустое название не сохраняем, поле подсвечиваем фокусом
    $('#taskTitle').focus();
    return;
  }
  const note = $('#taskNote').value.trim();
  const time = $('#taskTime').value;
  const priority = modal.querySelector('input[name="priority"]:checked').value;

  if (editingId) {
    const t = tasks.find((t) => t.id === editingId);
    if (t) Object.assign(t, { title, note, time, priority });
  } else {
    const task = {
      id: uid(), title, note, date: today(), status: 'active',
      priority, time, createdAt: Date.now(), completedAt: null, transferred: false,
    };
    pendingEnter.add(task.id); // анимация появления новой карточки
    tasks.push(task);
  }
  editingId = null;
  saveTasks();
  renderAll();
  modal.close();
}

/* ===================== События ===================== */

function wireEvents() {
  // Быстрое добавление (Enter в поле или кнопка «Добавить»)
  $('#quickAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#quickInput');
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    quickAdd(title);
    input.value = '';
    input.focus();
  });

  // Явный обработчик Enter в поле быстрого добавления: некоторые окружения
  // (встроенные WebView) не запускают implicit submission формы — делаем сами
  $('#quickInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#quickAddForm').requestSubmit();
    }
  });

  // Точки-переключатели приоритета быстрого добавления
  $('#prioritySwitch').addEventListener('click', (e) => {
    const dot = e.target.closest('[data-priority]');
    if (!dot) return;
    quickPriority = dot.dataset.priority;
    for (const d of $('#prioritySwitch').querySelectorAll('[data-priority]')) {
      d.classList.toggle('is-active', d === dot);
    }
  });

  // Модалка: создание «с деталями», сохранение, отмена
  $('#openDetailsBtn').addEventListener('click', () => openModal(null));
  $('#taskForm').addEventListener('submit', (e) => { e.preventDefault(); saveModal(); });
  $('#cancelModalBtn').addEventListener('click', () => modal.close());
  // Клик по тёмной подложке закрывает модалку
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  // Секции «Выполнено» и «Ранние дни»
  $('#doneToggle').addEventListener('click', () => { showDone = !showDone; renderAll(); });
  $('#historyToggle').addEventListener('click', () => { showHistory = !showHistory; renderAll(); });
  $('#clearDoneBtn').addEventListener('click', clearDone);
}

/* ===================== Запуск ===================== */

document.addEventListener('DOMContentLoaded', () => {
  if (!storageOK) {
    console.warn('localStorage недоступен — данные будут жить до перезагрузки страницы');
  }
  loadTasks();          // читаем (или сеем) задачи
  handleDayRollover();  // переносим невыполненное с прошлых дней
  wireEvents();
  renderAll();
});
