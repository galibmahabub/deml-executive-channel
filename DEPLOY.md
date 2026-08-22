[DEPLOY.md](https://github.com/user-attachments/files/31337690/DEPLOY.md)
# Putting DEML Executive Channel online — for free

This version serves the website AND the backend from one place, so you only
need to deploy one thing. We'll use **Render.com's free tier** — no credit
card required, and it lets multiple people from anywhere use it at the same
time.

Follow these in order. Don't skip steps.

---

## Part 1 — Put your code on GitHub (free)

Render needs to pull your code from somewhere. GitHub is the standard free
place for that.

1. Go to **github.com** and click **Sign up**. Make a free account.
2. Once logged in, click the **+** icon top-right → **New repository**.
3. Name it something like `deml-executive-channel`. Leave it **Public**.
   Don't check any extra boxes. Click **Create repository**.
4. On the next page, click the link that says **uploading an existing file**.
5. Drag these 3 items into the browser window:
   - `server.js`
   - `package.json`
   - the whole `public` folder (with `index.html` inside it)
6. Scroll down, click **Commit changes**.

Your code is now on GitHub. You should see `server.js`, `package.json`, and
a `public` folder listed.

---

## Part 2 — Deploy it on Render (free)

1. Go to **render.com** and click **Get Started**. Sign up using your
   **GitHub account** (easiest — one click, no new password).
2. On the Render dashboard, click **New +** → **Web Service**.
3. It will show your GitHub repos — click **Connect** next to the
   `deml-executive-channel` repo you just made.
4. Fill in the settings:
   - **Name**: anything you like, e.g. `deml-executive-channel`
   - **Region**: pick the one closest to you
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: choose **Free**
5. Before creating the service, scroll to **Environment Variables** and add
   one:
   - **Key**: `JWT_SECRET`
   - **Value**: any long, random string (30+ characters). You can generate
     one at [randomkeygen.com](https://randomkeygen.com) or just mash your
     keyboard for a while.

   **This step matters.** Your code is in a *public* GitHub repo, and the
   server has a fallback secret built in for local testing. If you skip
   this, anyone who looks at your repo could use that fallback secret to
   forge a login — including a President login. Setting your own secret
   here closes that off.
6. Scroll down, click **Create Web Service**.

Render will now install everything and start your server — you'll see logs
scrolling in the browser. This takes 2–5 minutes the first time.

7. When it's done, look near the top of the page for your URL — it'll look
   like:
   ```
   https://deml-executive-channel.onrender.com
   ```
8. **Open that URL in your browser.** That's your live website.
9. Look at the **Logs** tab in Render — the President username/password get
   printed there, the same way they did on your PC. Copy them down. (If you
   see a warning in the logs about `JWT_SECRET` not being set, go back and
   add the environment variable from step 5, then trigger a redeploy from
   the Render dashboard.)

That's it — that URL now works for anyone, anywhere, at the same time,
totally free.

---

## Things to know about the free plan

- **It falls asleep.** If nobody visits for about 15 minutes, Render puts it
  to sleep to save resources (this is normal on the free tier). The next
  person to visit will wait about 30–50 seconds while it wakes up, then it's
  fast again.
- **Data isn't permanent.** This app stores everything in memory (no
  database). Every time it sleeps and wakes, or you redeploy, **all users,
  messages, todos, and meetings reset** — including the President account,
  which regenerates a new password each time (check the Logs tab again).
- If you outgrow the free tier later (want it always-on, or want data to
  actually persist), that's when paid hosting or a real database comes in —
  but you don't need any of that to get this online and working for free
  right now.

## Updating your site later

Whenever you want to change something: edit the files on GitHub (or upload
new versions the same drag-and-drop way), and Render will automatically
redeploy the new version within a minute or two.
