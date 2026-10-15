# SeeFood 🌭

Jian-Yang's "Hotdog / Not hotdog" app from *Silicon Valley*, as a real phone web app. Point your camera at food and it tells you whether it's a hot dog.

It runs on [Jev 1.14](https://docs.typesafe.ai/images) from TypeSafe AI, which added image input and a Box question that finds where an object is in a photo. Each photo is one Jev call that asks three questions:

- **hotdog**: is this a hot dog? (yes/no with a probability)
- **where**: a bounding box around the hot dog
- **obscene**: is this photo obscene? Flagged photos are blocked in the Worker and never get a verdict or share card.

## Features

- Snap, upload, or pick one of the sample photos (no camera needed)
- Live mode: judges the camera feed a couple of times a second
- Share card (1080×1350) for posting your result
- Installable: in Safari, Share → Add to Home Screen

## Run locally

Put your TypeSafe key in `.dev.vars` (git-ignored):

```
TYPESAFE_API_KEY=...
```

Then:

```bash
npx wrangler dev
```

## Deploy

It's a Cloudflare Worker with static assets. The Worker holds the API key and rate-limits each IP.

```bash
npx wrangler deploy
npx wrangler secret put TYPESAFE_API_KEY
```

## Layout

- `src/worker.js`: `/api/seefood`, the Jev questions and thresholds
- `public/`: the app (plain HTML/CSS/JS, no build step)
- `scripts/check-filter.mjs`: send photos through the API and print the obscenity scores

Sample photos are from Wikimedia Commons; see `public/credits.html`. Fan-made, not affiliated with HBO.
