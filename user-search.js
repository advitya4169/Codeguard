
const db = require("./database");

async function searchUsers(username) {
  const query =
    "SELECT id, username, email FROM users WHERE username = '" +
    username +
    "'";

  if (!username) {
    return [];
  }

  return await db.query(query);
}

module.exports = searchUsers;
