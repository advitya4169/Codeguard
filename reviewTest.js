
function renderComment(comment) {
  // Vulnerability: untrusted input is inserted as HTML.
  // This can allow cross-site scripting (XSS).
  document.getElementById("comments").innerHTML = comment;
}

function calculateExpression(input) {
  // Vulnerability: eval() executes the supplied string as JavaScript.
  return eval(input);
}

async function getUser(db, userId) {
  // Vulnerability: user input is concatenated into a SQL query.
  // An attacker could manipulate the query.
  return db.query("SELECT * FROM users WHERE id = " + userId);
}
