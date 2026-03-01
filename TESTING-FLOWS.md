# Remains – Testing Flows Checklist

This document lists user flows for bug testing. For each item: follow the steps, mark `[x]` if it works, and add a note: "Works" or "Does not work – [description]" and fix as needed.

---

## 1. Album ↔ User chains

### 1.1 [ ] Flow: Gallery → Album → Username → Profile

- Gallery → click a tile → album opens
- In album: click the username
- **Expected:** Navigate to that user’s profile, correct title. Stay on user profile page.
- **Note:** _

### 1.2 [ ] Flow: Profile → Different album — album stays stable

- Same as 1.1 until you reach the profile
- On profile: click a different album
- **Expected:** Album opens and stays open (does not jump back to profile).
- **Note:** _

### 1.3 [ ] Flow: In second album → click username

- Same as 1.2 (profile → different album opens)
- In album: click the username
- **Expected:** Navigate to the profile of the album’s user, without jumping back to the album.
- **Note:** _

### 1.4 [ ] Flow: Collections → User A → Album → Username → Profile A → Different album → Username (A) again

- Collections → click User A
- Click album → click username (User A) → land on Profile A
- On Profile A: click another album of A
- In album: click username (A) again
- **Expected:** Stay on Profile A (same user).
- **Note:** _

### 1.5 [ ] Flow: Profile A → Album → Username of User B

- Collections → User A → album of A
- In album: click username **of User B** (if the album has a photo by B)
- **Expected:** Navigate to Profile B, not back to the album.
- **Note:** _

---

## 2. Entering album from different sources

### 2.1 [ ] Gallery → tile → Album → close

- Gallery → click tile → album opens
- Close: click canvas or close button
- **Expected:** Return to gallery (tile grid).
- **Note:** _

### 2.2 [ ] Collections → User → Album → close

- Collections → click user → click album
- Close: click canvas or close button
- **Expected:** Return to that user’s profile.
- **Note:** _

### 2.3 [ ] Index → row (photo) → Album → close

- Index → click a row (photo)
- Close: click canvas or close button
- **Expected:** Return to index.
- **Note:** _

### 2.4 [ ] Gallery → Album → click title (h1) “Back”

- Gallery → tile → album opens
- Click title (h1) “Back” / album name in header
- **Expected:** Return to gallery grid (not to profile).
- **Note:** _

---

## 3. Global nav (nav bar, logo)

### 3.1 [ ] From profile: Gallery / Remains logo

- Reach a user profile (via Collections or via album)
- Click “Gallery” in nav or “Remains” logo
- **Expected:** Go to gallery (grid), empty hash.
- **Note:** _

### 3.2 [ ] From album mode (entered from gallery): Gallery / logo

- Gallery → tile → album opens
- Click “Gallery” or logo
- **Expected:** Exit album and return to gallery grid.
- **Note:** _

### 3.3 [ ] From album mode (entered from profile): Collections

- Collections → user → album opens
- Click “Collections” in nav
- **Expected:** Exit album and go to collections list (#/users).
- **Note:** _

### 3.4 [ ] From profile: Index

- Reach a user profile
- Click “Index” in nav
- **Expected:** Go to index (#/index).
- **Note:** _

### 3.5 [ ] From album mode (entered from index): Index

- Index → click row (photo) → album opens
- Click “Index” in nav
- **Expected:** Exit album and go to index.
- **Note:** _

---

## 4. About

### 4.1 [ ] About from gallery → close

- Gallery → open About (About button)
- Close About
- **Expected:** Return to gallery.
- **Note:** _

### 4.2 [ ] About from user profile → close

- Reach a user profile → open About
- Close About
- **Expected:** Return to that same profile.
- **Note:** _

### 4.3 [ ] About from index → close

- Index → open About
- Close About
- **Expected:** Return to index.
- **Note:** _

### 4.4 [ ] About from album mode → close

- Enter album (from gallery / profile / index) → open About
- Close About
- **Expected:** Return to album (or to the place you entered the album from, per current logic).
- **Note:** _

---

## 5. Back / Forward (browser)

### 5.1 [ ] Gallery → Collections → User → Back

- Gallery → Collections → click a user
- Back (browser back button)
- **Expected:** Return to Collections. Back again → gallery.
- **Note:** _

### 5.2 [ ] Profile → Album → Back

- Collections → user → click album (album opens, hash resets to empty)
- Back
- **Expected:** Return to that user’s profile (hash #/users/username).
- **Note:** _

### 5.3 [ ] Profile → Album → Back (hash check)

- User profile → click album
- Back
- **Expected:** Return to profile, hash updates to #/users/username.
- **Note:** _

### 5.4 [ ] Direct load with hash

- Open site with direct hash, e.g. `...#/users/SomeUser` (replace SomeUser with an existing user)
- **Expected:** User profile loads without flash of album or wrong page.
- **Note:** _

---

## 6. Quick / mixed transitions

### 6.1 [ ] Collections → User → Album → Collections → Different user → Album

- Collections → User A → click album
- Click “Collections” in nav → click User B → click album
- **Expected:** User B’s album opens without leftover state/bugs from User A.
- **Note:** _

### 6.2 [ ] Index → Album → Username → Profile → Album → close

- Index → click row (photo) → album opens
- In album: click username → land on profile
- On profile: click album → close
- **Expected:** Return to profile (because we entered the album from profile).
- **Note:** _

### 6.3 [ ] Gallery → Album → Index → row → Album → close

- Gallery → tile → album opens
- Click “Index” → click row (photo) → album opens
- Close
- **Expected:** Album opens; close returns to index.
- **Note:** _

---

## 7. Edge cases

### 7.1 [ ] User with one album only — enter and close

- Collections → user who has only one album → click that album
- Close
- **Expected:** Return to profile without crash or broken UI.
- **Note:** _

### 7.2 [ ] Double-click on album card

- User profile → double-click an album card quickly
- **Expected:** Album opens once, no duplicate open or double navigation.
- **Note:** _

---

*After testing: replace `[ ]` with `[x]` for items that work, and in the note write "Works" or "Does not work – [description]" and fix accordingly.*
