# Migrating from 4.x to 5.0

Charness 5.0 changes the **licence** from the Charness License 1.0.0 to the **Charness License 2.0**, the one
[LICENSE](LICENSE) file. The commands, the settings and the way you run the bot are the same. An install is never moved to
5.0 by itself: an npm install offers it in General and waits for your tap, and a checkout install holds the update
because this file is new.

## What changed

Two new obligations (LICENSE sections 2.3 and 3.3):

- **Derived code.** Code, skills or prompts written on the basis of Charness code or commits, taking over its approaches
  and solutions, are under the licence like Charness itself, including such code an AI model wrote with Charness code or
  commits in its context. Unless your work takes over those approaches, it is not derived merely because Charness gave
  your agents its prompts, skills and tool descriptions (sections 2.3–2.4).
- **AI training.** A group that uses, sells or offers a model trained or fine-tuned on Charness code or commits — by its
  own people, by anyone for it, or by whoever it got the model's weights from — pays its yearly band price for it, on top
  of its licence (section 3.3).

Everything else keeps its substance: the free tier, the band prices, the OEM table, the discounts and the refund. The
paid terms that lived in `LICENSE-COMMERCIAL.md` are now Part 3 of `LICENSE`. Code and commits published under MIT stay
MIT; a copy keeps the licence file it came with.

## What you have to do

- **You do not train models on Charness and do not build code on Charness's own code:** nothing new; update when you
  like.
- **You do either:** read LICENSE sections 2.3–2.6 and 3.3 before you update, and buy the training licence if it applies
  (LICENSE section 3.7).
- **You want to stay on the 1.0.0 terms:** stay on a 4.x release; its own licence files keep applying to it.
