# Printshop — staff guide

Type what you want, pick the paper size, get a print file.

---

## First time only

1. Install the app (right-click → **Open** the first time on Mac; on Windows click **More info → Run anyway**).
2. Open **Settings** → check it says **Signed in**. If not, press **Sign in to Codex** and finish in the browser that opens.
3. If your press uses a colour profile, press **Profile…** and pick the `.icc` file.

If Settings says *Codex CLI not found*, stop — the machine is not set up. Tell whoever installed it.

---

## Making artwork

1. **Type the job** in the prompt box. Plain words are fine: *"birthday poster, dinosaur theme, kid turning 5"*.
2. Press **Improve with Codex** if you want it written properly. **Revert** puts your words back.
3. **Pick the size.** A4, Letter, 4 × 6 photo, bunting, banner — or Custom in mm, cm, inches or feet.
4. **Check the orange line** under Size. See the resolution warning below.
5. **Variants** — how many to choose from. 2 is usually enough.
6. **Generate.** This takes a few minutes. The progress bar counts real finished images; the log shows what it is doing. It has not frozen.

---

## Choosing and exporting

Click a picture to select it. Press **⤢** or double-click to see it big.

Then set:

- **Format** — PDF for the press, PNG or JPEG for a customer preview, TIFF if asked for it.
- **Colour** — RGB normally. CMYK if the press wants separations.
- **Watermark** — On for a customer proof, Off for the real file. Type whatever you want in it.

Press **Export**, then **Open folder**.

Everything lands in one folder per job — every picture you generated plus your export. Nothing is ever deleted, and a proof can never overwrite the real file: the filename says which is which.

```
sunset-poster-a1b2/
  01.png  02.png                        the pictures it made
  sunset-poster-a1b2-A4.pdf             the real file
  sunset-poster-a1b2-A4-PROOF.pdf       the customer proof
```

---

## The resolution warning — read this one

The line under Size tells you if the picture is sharp enough **for that size**:

- **"fine for print"** — go ahead.
- **"usable"** — acceptable, not perfect. Fine for most jobs.
- **"too low"** — it will look soft or blocky on paper. Do not send it to the press as-is.

Roughly what to expect:

| Job | Verdict |
|---|---|
| Photo prints, A6, A5 | fine |
| A4, A3 | soft — proofs and internal work |
| A2 and bigger, bunting, banner | **not print-ready** |

**Bunting and banner:** use the picture as a starting idea only. Open it in your design software, redo the text as proper vector type, and build the final file there. The app cannot make a sharp 5-foot bunting — no setting changes this.

---

## When something goes wrong

| What you see | What it means |
|---|---|
| Red text after Generate | The actual error, word for word. Usually not signed in, or the prompt was refused. |
| *Not signed in* | Settings → **Sign in to Codex**. |
| Nothing happening for a minute | Normal. The log line says *working, Ns since last step*. Leave it. |
| *PNG cannot hold CMYK* | Correct — PNG has no CMYK. Use PDF, JPEG or TIFF. |
| *Set your CMYK profile* | Settings → **Profile…** → pick the press `.icc`. |

Generating costs nothing per image — it runs on the shop's ChatGPT plan. If it starts refusing, the plan's limit has been reached for now; wait and try again.
