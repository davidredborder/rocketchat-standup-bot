
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '../data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Use a file-based database; it will be created if it doesn't exist.
const db = new sqlite3.Database(path.join(dataDir, 'standup.db'), (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

/**
 * Initializes the database by creating the necessary tables if they don't exist.
 */
const initializeDatabase = () => {
  db.serialize(() => {
    // Create a table to store the history of each standup session.
    db.run(`
      CREATE TABLE IF NOT EXISTS standups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_date TEXT NOT NULL UNIQUE
      )
    `, (err) => {
      if (err) {
        console.error('Error creating standups table:', err.message);
      } else {
        console.log('Table "standups" is ready.');
      }
    });

    // Create a table to store user responses for each standup.
    db.run(`
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        questions TEXT NOT NULL,
        answers TEXT,
        status TEXT NOT NULL,
        FOREIGN KEY (standup_id) REFERENCES standups (id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating responses table:', err.message);
      } else {
        console.log('Table "responses" is ready.');
      }
    });
  });
};

module.exports = {
  db,
  initializeDatabase
};
