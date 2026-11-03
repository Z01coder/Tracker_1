/**
 * «Дейлик» — трекер задач на день (Tracker_1).
 *
 * Сервер максимально простой: только раздаёт статику из папки public/.
 * Вся логика приложения (задачи, приоритеты, автоперенос на новый день)
 * живёт на клиенте в public/js/app.js, данные — в localStorage браузера,
 * поэтому бэкенду не нужны ни база данных, ни API-роуты.
 *
 * Запуск: npm start (или node server.js). Порт 3001, слушать на 0.0.0.0,
 * чтобы приложение было доступно и с других устройств в локальной сети.
 */

'use strict';

const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001; // PORT задаёт Railway при деплое, локально — 3001

// Раздаём статику (index.html, css/, js/, assets/) из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница: express.static сам отдаёт index.html, но оставим
// явный роут, чтобы поведение было очевидным при чтении кода
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ «Дейлик» запущен: http://localhost:${PORT}`);
});
