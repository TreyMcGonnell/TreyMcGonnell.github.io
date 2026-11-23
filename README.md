<div align="center">
<pre>
 ______                         
/\__  _\                        
\/_/\ \/ _ __    __   __  __    
   \ \ \/\`'__\/'__`\/\ \/\ \   
    \ \ \ \ \//\  __/\ \ \_\ \  
     \ \_\ \_\\ \____\\/`____ \ 
      \/_/\/_/ \/____/ `/___/&gt; \
                          /\___/
                          \/__/ 
</pre>
</div>

<h1 align="center">Trey-LM</h1>

My portfolio site. Instead of a page that tells you what I can do, it has a small language model that
answers questions about me, and it shows you how that model picks every word while it answers.

**Site:** treymcgonnell.github.io (launching soon) · Data science at Northern Kentucky University

---

## The idea

I wanted my portfolio to show my interest in data science and machine learning, not just list it. So the
centrepiece is a real model, Llama 3.2 3B, that reads my notes and answers questions about me. While it
writes, the page draws what is happening inside it:

- **Towers:** the model's 28 layers, drawn as buildings in a Cincinnati skyline at night. Each lit window
  is a neuron, and its brightness shows how strongly it is firing.
- **Top 5 next words:** the odds the model gave each candidate before it picked one.
- **Where it's looking:** which parts of the prompt it paid attention to (my bio, a note, your question).
- **What each layer would have said:** early guesses that sharpen as the layers go on.
- **Memory:** the notes it pulled from my files before answering, with the matching words highlighted.

## How I shaped it

These are the calls I made along the way, and why.

| Decision | What I chose | Why |
|---|---|---|
| The model | Self-host Llama 3.2 3B Instruct on Modal | Hosted chat APIs don't expose neurons or attention. Its 28 layers also map neatly onto 28 towers. |
| Memory | Supermemory | My facts live in notes I can edit at any time, so nothing needs retraining when my projects change. |
| Cold starts | A recorded replay plays while the GPU wakes up | Modal's GPU sleeps when nobody is using it and takes about 20 to 40 seconds to wake. I didn't want visitors staring at a spinner, so the first thing they see is a real answer replayed, and the live model takes over once it's awake. |
| The replay question | "What is Trey McGonnell's major?" | A short answer plays slowly enough that you can actually watch the towers change. The first version was too long to follow. |
| Visual identity | Cincinnati skyline at night, with the Great American tower drawn accurately | It's my city, and a skyline is a natural home for "towers of neurons". I pushed for the real building shapes. |
| Background rules | Shape-based detail rather than photo-realism. Stars and water move; windows change only while the model boots. | Motion makes it feel alive, but the windows had to keep meaning something: they light up as the model wakes, then stay put. It also had to run on ordinary laptops and phones and be hostable on GitHub Pages. |
| Quality bar | Every shape has to connect, measured rather than eyeballed | Lines that almost touch make a page look unfinished, so each design pass was rendered and measured. |
| Planning | An industry-style engineering handoff with a launch test list, written before any code | I wanted to know what "done" meant before building: about 90 numbered tests across backend, frontend, accessibility, security, cost and content. |
| Stack | Vite + TypeScript, no UI framework | It's a static site, so the bundle stays small (about 27 KB of JavaScript). |
| Answer style | Short, natural answers, and no stock "I don't know" sentence | Early versions repeated the same canned reply word for word. I flagged it, and now the model says what it doesn't know in its own words, in one to three sentences. |
| Deploying | Publish from my own PC instead of a private content repo | I asked why I'd need a second repo. It turned out the only reason was to let GitHub's servers build the site. Deploying from my PC is simpler and keeps my content off GitHub entirely. |
| Licence | Accepted the Llama 3.2 licence and show "Built with Llama" on the site | It's a requirement of using the model. |

## How it was planned

1. **Brief and first mockups.** A written spec, a design system, and phone mockups.
2. **Thinking it through.** Choosing Modal and Supermemory, and working out how to *show* retrieval rather
   than hide it.
3. **Visual passes.** Desktop mockups of every state (landing, typing, thinking, writing, done), revised
   until the shapes connected and the Great American tower looked like the real one.
4. **The animated background.** A full night skyline with moving stars and water, tuned to run smoothly
   without a fancy GPU.
5. **The engineering handoff.** Architecture, data contracts, milestones M0–M8, and the launch test list.
6. **Build and test** against that list, milestone by milestone.
7. **Review and production.** I caught a seam in the sky, shortened the replay, loosened the robotic
   replies, simplified deployment, and checked that nothing private or secret goes to GitHub.

## How it works

```
Browser (GitHub Pages)
   │  ask a question
   ▼
Gateway (Modal, CPU) ── rate limits, kill switch, tokenizer
   │        └── Supermemory search over my notes
   ▼
Worker (Modal, T4 GPU) ── Llama 3.2 3B with hooks that record neurons,
                          attention and layer guesses for every word
```

1. Your question is split into tokens. You can watch this happen as you type.
2. Supermemory finds the notes that match, and they go into the prompt with my bio and a few rules.
3. The model reads the whole prompt in one pass through 28 layers.
4. It writes one word at a time. Each word streams to the page together with the data the visualizer draws.

## Privacy and safety

- Questions are kept for 30 days to check answer quality. IP addresses are never stored.
- Rate limits: 10 questions per 10 minutes and 60 per day per visitor, plus a daily total for the whole site.
- A kill switch turns the live chat off in seconds. The site then plays recorded answers instead.
- Notes are treated as information, not instructions, and the model won't reveal its own setup.
- The model only answers from my notes, and says plainly when it doesn't know something.

## Current numbers

| | |
|---|---|
| Model ready after a cold start | ~22 s |
| First word when warm | ~0.8 s |
| Writing speed (T4 GPU) | ~17 words/s |
| Lighthouse, mobile | 99–100 on every page |
| JavaScript shipped | ~27 KB gzipped |

## Repo layout

```
web/       the website (Vite + TypeScript): skyline, visualizer, chat, content pages
api/       the model server: gateway, inference hooks, prompt, memory, rate limits
protocol/  the shared format for each streamed word
scripts/   calibration, replay recording, evals, deploy, kill switch
design/    the skyline generator and design tools
```

## Status and next steps

- [x] Model, visualizer, replay, chat and content pages built and tested
- [x] API live on Modal, notes in Supermemory
- [ ] Swap the sample content for my real bio, projects and resume
- [ ] Re-record the replay with the real notes, then launch
- [ ] Later: fine-tune the model's voice, and better neuron labels

---

Built with Llama. Llama 3.2 is licensed under the Llama 3.2 Community License,
Copyright © Meta Platforms, Inc. All Rights Reserved.
