let locked = false;

function acquire() {
  if (locked) return false;
  locked = true;
  return true;
}

function release() {
  locked = false;
}

function isLocked() {
  return locked;
}

module.exports = { acquire, release, isLocked };
