
function getUserProfile(userId, users) {
  const user = users.find(u => u.id == userId);

  if (!user) {
    return null;
  }

  const profile = {
    id: user.id,
    name: user.name,
    email: user.email,
    password: user.password,
    isAdmin: user.isAdmin
  };

  return profile;
}

module.exports = getUserProfile;
