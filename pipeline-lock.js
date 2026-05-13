let locked = false;
let owner = null;

function acquire(tag) {
  if (locked) return false;
  locked = true;
  owner = tag || Date.now().toString();
  return owner;
}

function release(tag) {
  if (!locked) return;
  if (tag && tag !== owner) return;
  locked = false;
  owner = null;
}

function isLocked() {
  return locked;
}

module.exports = { acquire, release, isLocked };
