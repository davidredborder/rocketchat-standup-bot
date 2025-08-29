// index.js
// A Rocket.Chat standup bot that prompts users for questions
// and publishes a summary.

// --- 1. Dependencies and Setup ---
// Load environment variables from a .env file
require('dotenv').config();

// Import the Rocket.Chat SDK
const { driver, api } = require('@rocket.chat/sdk');

// Import the scheduling library
const cron = require('node-cron');

// Import database setup
const { db, initializeDatabase } = require('./database.js');

// Initialize the database
initializeDatabase();


// --- 2. Environment Variables ---
// Retrieve all necessary variables from the .env file.
const ROCKCHAT_URL = process.env.ROCKETCHAT_URL;
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_PASSWORD = process.env.BOT_PASSWORD;
const STANDUP_USERS = process.env.STANDUP_USERS.split(',').map(user => user.trim());
const SUMMARY_CHANNEL_NAME = process.env.SUMMARY_CHANNEL_NAME;
const STANDUP_TIME = process.env.STANDUP_TIME || '0 9 * * 1-5'; // Default to 9:00 AM on weekdays
const QUESTIONS_ARRAY = process.env.QUESTIONS.split(';').map(q => q.trim());
const SUMMARY_TIMEOUT_MINUTES = parseInt(process.env.SUMMARY_TIMEOUT_MINUTES, 10) || 30;

// Global variables to store the channel IDs after lookup.
let SUMMARY_CHANNEL_ID;
let BOT_USER_ID;
let VALID_STANDUP_MEMBERS = [];

// --- 3. Core Bot Functions ---

/**
 * Gets the ID of a user by their username.
 * @param {string} username The username of the user.
 * @returns {string} The ID of the user.
 */
const getUserIdByUsername = async (username) => {
  try {
    const userInfo = await api.get('users.info', { username: username });
    if (userInfo && userInfo.user && userInfo.user._id) {
      console.log(`Found ID for user "${username}": ${userInfo.user._id}`);
      return userInfo.user._id;
    }
  } catch (error) {
    console.error(`Error finding user ID for "${username}":`, error.message);
  }
  return null;
};


/**
 * Connects the bot to the Rocket.Chat server and logs in.
 */
const connect = async () => {
  try {
    console.log('Connecting to Rocket.Chat...');
    await driver.connect({ host: ROCKCHAT_URL, useSsl: ROCKCHAT_URL.startsWith('https') });
    const loginResult = await driver.login({ username: BOT_USERNAME, password: BOT_PASSWORD });
    BOT_USER_ID = loginResult.userId;
    console.log('Logged in successfully!');

    // Explicitly log in the API module to prevent it from using default credentials.
    await api.login({ username: BOT_USERNAME, password: BOT_PASSWORD });
    
    // Get the channel IDs from their names using the SDK's built-in methods
    SUMMARY_CHANNEL_ID = await driver.getRoomId(SUMMARY_CHANNEL_NAME);

    if (!SUMMARY_CHANNEL_ID) {
      console.error(`Could not find a channel named "${SUMMARY_CHANNEL_NAME}". Exiting.`);
      process.exit(1);
    }

    // Check for user existence at startup
    console.log(`[connect] Checking existence for users: ${STANDUP_USERS.join(', ')}`);
    for (const username of STANDUP_USERS) {
      if (username === BOT_USERNAME) {
        console.log(`[connect] Skipping bot user: ${username}`);
        continue;
      }
      const userId = await getUserIdByUsername(username);
      if (userId) {
        VALID_STANDUP_MEMBERS.push({ _id: userId, username: username });
      } else {
        console.log(`[connect] User "${username}" not found. Skipping.`);
      }
    }
    
    // Set up the Realtime API listener after successful login
    setupRealtimeApiListener();
  } catch (error) {
    console.error('Failed to connect and log in:', error.message);
    process.exit(1); // Exit if connection fails
  }
};

/**
 * Sets up a listener for new direct messages using the Realtime API.
 */
const setupRealtimeApiListener = async () => {
  try {
    console.log('Subscribing to direct messages...');
    
    // Subscribe to messages in the bot's direct message stream
    await driver.subscribeToMessages();

    // Set up the message processing callback
    driver.reactToMessages((err, message, messageOptions) => {
      if (err) {
        console.error('Error in Realtime API subscription:', err);
        return;
      }
      
      // We only care about new messages in the DM stream from other users
      if (message.u && message.u._id !== BOT_USER_ID && messageOptions.roomType === 'd' && !message.editedAt) {
        console.log(`Received message from ${message.u.username} in DM.`);
        processStandupResponse(message);
      }
    });
    
  } catch (error) {
    console.error('Failed to subscribe to Realtime API:', error.message);
  }
};

/**
 * Sends a direct message to a specific user.
 * @param {object} member The full member object from the member list.
 * @param {string} text The message text to send.
 */
const sendDirectMessage = async (member, text) => {
  try {
    console.log(`[sendDirectMessage] Attempting to create DM channel for user: ${member.username} (ID: ${member._id})`);
    
    // Create a DM room with the user's username
    const imCreateResult = await api.post('im.create', { username: member.username });
    const dmRoomId = imCreateResult.room._id;
    console.log(`[sendDirectMessage] Created/found DM room with ID: ${dmRoomId}`);

    // Now send the message to the created/found DM room
    const result = await driver.sendToRoomId(text, dmRoomId);
    console.log(`[sendDirectMessage] Sent DM to user: ${member.username}`);
    console.log(`[sendDirectMessage] sendDirectToUser result:`, result);
  } catch (error) {
    console.error(`[sendDirectMessage] Failed to send DM to ${member.username}:`, error.message);
  }
};

/**
 * Publishes a summary for a single user to the summary channel.
 * @param {object} userResponse The user's response object from the database.
 */
const publishIndividualSummary = async (userResponse) => {
  const answers = JSON.parse(userResponse.answers);
  const questions = JSON.parse(userResponse.questions);

  // Use Rocket.Chat's attachments API to create a colored message block.
  const attachments = answers.map((ans, i) => {
    let color;
    // Assign a different color for each question
    switch(i) {
      case 0:
        color = '#00BFFF'; // Blue
        break;
      case 1:
        color = '#32CD32'; // Green
        break;
      case 2:
        color = '#FFD700'; // Gold
        break;
      default:
        color = '#808080'; // Grey
    }

    // Replace literal '\n' characters with escaped newlines for the API payload
    const formattedAnswer = ans.replace(/\n/g, '\\n');
    
    return {
      color: color,
      title: questions[i],
      text: formattedAnswer
    };
  });
  
  try {
    console.log(`[publishIndividualSummary] Attempting to publish summary for ${userResponse.username} to room ID: ${SUMMARY_CHANNEL_ID}`);
    // Use the api.post method with the chat.postMessage endpoint for attachments
    const result = await api.post('chat.postMessage', {
      channel: SUMMARY_CHANNEL_ID,
      text: `--- @${userResponse.username} has completed his standup ---
`,
      attachments: attachments
    });
    console.log('[publishIndividualSummary] Individual summary published successfully!', result);
  } catch (error) {
    console.error('[publishIndividualSummary] Failed to publish summary:', error.message);
  }
};

/**
 * Asks the next question to the user.
 * @param {string} userId The user's ID.
 */
const askNextQuestion = async (userId) => {
    db.get('SELECT * FROM responses WHERE user_id = ? AND status = "pending" ORDER BY id DESC LIMIT 1', [userId], async (err, userResponse) => {
        if (err) {
            console.error('Database error in askNextQuestion:', err.message);
            return;
        }

        if (!userResponse) {
            // This can happen if the user tries to continue an old standup.
            console.log(`[askNextQuestion] No pending standup found for user ID: ${userId}`);
            return;
        }

        const answers = userResponse.answers ? JSON.parse(userResponse.answers) : [];
        const questions = JSON.parse(userResponse.questions);
        const currentQuestionIndex = answers.length;

        if (currentQuestionIndex < questions.length) {
            const nextQuestion = questions[currentQuestionIndex];
            let messageText;
            if (currentQuestionIndex === 0) {
                messageText = `Hi ${userResponse.username}! It's time for today's standup. You can type **'skip'** at any time to skip. Please note that answers **cannot** be edited.

- ${nextQuestion}`;
            } else {
                messageText = `- ${nextQuestion}`;
            }
            await sendDirectMessage({ _id: userId, username: userResponse.username }, messageText);
        } else {
            // All questions answered, update status and publish the summary.
            db.run('UPDATE responses SET status = "answered" WHERE id = ?', [userResponse.id], async (err) => {
                if (err) {
                    console.error('Database error updating status to answered:', err.message);
                    return;
                }
                await publishIndividualSummary(userResponse);
            });
        }
    });
};


/**
 * Prompts all users in the standup channel with the questions.
 */
const promptUsersForStandup = async () => {
    console.log(`
--- Starting daily standup for specified users ---`);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    db.run('INSERT INTO standups (standup_date) VALUES (?)', [today], function(err) {
        if (err) {
            // If it's a UNIQUE constraint error, a standup for today already exists.
            if (err.message.includes('UNIQUE constraint failed')) {
                console.log(`A standup for ${today} has already been initiated.`);
            } else {
                console.error('Database error creating new standup session:', err.message);
            }
            // We still need the ID for the existing standup
            getStandupAndPrompt();
        } else {
            console.log(`Created new standup session for ${today} with ID: ${this.lastID}`);
            // If we just created it, now we can proceed.
            getStandupAndPrompt(this.lastID);
        }
    });

    const getStandupAndPrompt = (standupId) => {
        if (standupId) {
            prompt(standupId);
        } else {
            db.get('SELECT id FROM standups WHERE standup_date = ?', [today], (err, row) => {
                if (err || !row) {
                    console.error('Could not find or create a standup session for today.');
                    return;
                }
                prompt(row.id);
            });
        }
    };

    const prompt = async (standupId) => {
        console.log(`[promptUsersForStandup] Found ${VALID_STANDUP_MEMBERS.length} valid members for standup.`);
        console.log(`[promptUsersForStandup] Member list:`, VALID_STANDUP_MEMBERS.map(m => m.username));

        for (const member of VALID_STANDUP_MEMBERS) {
            const responseData = {
                standup_id: standupId,
                user_id: member._id,
                username: member.username,
                questions: JSON.stringify(QUESTIONS_ARRAY),
                answers: JSON.stringify([]),
                status: 'pending'
            };

            db.run(
                'INSERT INTO responses (standup_id, user_id, username, questions, answers, status) VALUES (?, ?, ?, ?, ?, ?)',
                [responseData.standup_id, responseData.user_id, responseData.username, responseData.questions, responseData.answers, responseData.status],
                async function(err) {
                    if (err) {
                        console.error(`Error creating pending response for ${member.username}:`, err.message);
                    } else {
                        console.log(`Created pending response for ${member.username}.`);
                        await askNextQuestion(member._id);
                        await new Promise(resolve => setTimeout(resolve, 5000)); // Avoid rate-limiting
                    }
                }
            );
        }
        
        const summaryScheduleTime = new Date(Date.now() + SUMMARY_TIMEOUT_MINUTES * 60 * 1000);
        console.log(`[promptUsersForStandup] Final standup summary scheduled for: ${summaryScheduleTime.toLocaleTimeString()}`);
        setTimeout(publishStandupSummary, SUMMARY_TIMEOUT_MINUTES * 60 * 1000);
    };
};


/**
 * Compiles and publishes the final standup summary for non-respondents.
 */
const publishStandupSummary = async () => {
    console.log(`
--- Publishing final standup summary for channel ${SUMMARY_CHANNEL_NAME} ---`);
    const today = new Date().toISOString().slice(0, 10);

    db.all(`
        SELECT r.username, r.status
        FROM responses r
        JOIN standups s ON r.standup_id = s.id
        WHERE s.standup_date = ? AND (r.status = 'pending' OR r.status = 'skipped')
    `, [today], async (err, rows) => {
        if (err) {
            console.error('Database error fetching non-respondents:', err.message);
            return;
        }

        if (rows.length === 0) {
            console.log('[publishStandupSummary] All users responded or skipped individually. No final summary needed.');
            return;
        }

        let summaryText = `Daily Standup Summary

`;
        rows.forEach(row => {
            if (row.status === 'skipped') {
                summaryText += `@${row.username}: Skipped the standup.

`;
            } else {
                summaryText += `@${row.username}: Did not respond.

`;
            }
        });

        try {
            console.log(`[publishStandupSummary] Attempting to publish final summary to room ID: ${SUMMARY_CHANNEL_ID}`);
            await driver.sendToRoomId(summaryText, SUMMARY_CHANNEL_ID);
            console.log('[publishStandupSummary] Final summary published successfully!');
        } catch (error) {
            console.error('[publishStandupSummary] Failed to publish summary:', error.message);
        }
    });
};


/**
 * Process incoming DM messages and them as standup responses.
 * @param {object} message The message object from the Realtime API.
 */
const processStandupResponse = (message) => {
    const userId = message.u._id;
    const text = message.msg;

    db.get('SELECT * FROM responses WHERE user_id = ? AND status = "pending" ORDER BY id DESC LIMIT 1', [userId], (err, userResponse) => {
        if (err) {
            console.error('Database error in processStandupResponse:', err.message);
            return;
        }

        if (userResponse) {
            if (text.toLowerCase().trim() === 'skip') {
                db.run('UPDATE responses SET status = "skipped" WHERE id = ?', [userResponse.id], (err) => {
                    if (err) {
                        console.error('Database error updating status to skipped:', err.message);
                        return;
                    }
                    console.log(`@${userResponse.username} skipped the standup.`);
                    sendDirectMessage({ _id: userId, username: userResponse.username }, "You have skipped today's standup. Thank you.");
                    
                    let summaryText = `@${userResponse.username} has skipped his standup.`;
                    driver.sendToRoomId(summaryText, SUMMARY_CHANNEL_ID);
                });
            } else {
                const answers = JSON.parse(userResponse.answers);
                answers.push(text);
                const newAnswers = JSON.stringify(answers);

                db.run('UPDATE responses SET answers = ? WHERE id = ?', [newAnswers, userResponse.id], (err) => {
                    if (err) {
                        console.error('Database error saving answer:', err.message);
                        return;
                    }
                    console.log(`@${userResponse.username} answered question ${answers.length}.`);
                    askNextQuestion(userId);
                });
            }
        }
    });
};


// --- 4. Main Execution ---
// Schedule the standup to run at the configured time and days.
// The syntax is 'minute hour day_of_month month day_of_week'
// Example: '0 9 * * 1-5' means 9:00 AM on Monday through Friday
cron.schedule(STANDUP_TIME, promptUsersForStandup);

// Connect to Rocket.Chat on application start
connect();

// Keep the Node.js process running for the cron scheduler
console.log(`Standup bot is running. It will prompt for standup at: ${STANDUP_TIME}`);