# Migrating from 3.x to 4.0

> This guide describes the change made by 4.0.0 and the Charness License 1.0.0 it introduced. The licence of the current
> code, with its prices and how to buy, is the repository's [LICENSE](LICENSE); a copy keeps the licence file it came with.

Charness 4.0 changes the **license**. The commands, the settings and the way you run the bot are the same; what changes
is what you may do with the software and who pays for it.

**Effective from the day 4.0.0 is released** (its date is on the GitHub release and in the CHANGELOG heading). Every
release before 4.0 was published under the MIT license and **stays MIT**: nothing about it is revoked, nothing is billed
retroactively, and you may keep running it for as long as you like.

## What changed

- 4.0.0 moved Charness to the [Charness License 1.0.0](https://github.com/olosegres/charness/blob/v4.2.0/LICENSE) — **source-available, not
  open source**. It is PolyForm Small Business 1.0.0 with its "small business" grant replaced by the terms below.
- Charness stays **free** for:
  - personal use — hobby projects and study;
  - any organization group whose **revenue plus funding** (R) is at most **$500,000** AND whose **people** (H) are at most
    **20**;
  - teaching, research, charities and public bodies for their core work, whatever their budget or headcount;
  - a one-time evaluation of less than 32 consecutive days.
- Every other organization group buys **one annual license** for the whole group — unlimited users, agents, jobs and
  machines, **no seats**. Hosting, model costs, setup and support are not included.
- No license keys, no activation, no telemetry and no remote shutdown: the license is honour-based, with a narrow
  verification clause. The bot never shows a purchase prompt.

## Who pays

The fee is the **higher** of the revenue band and the people band:

| Band | R: revenue plus counted funding | H: all people in the group | Per year |
|---|---|---|---:|
| Free | up to $500,000 | up to 20 | $0 |
| Small | up to $2 million | 21–50 | $500 |
| Growing | up to $10 million | 51–250 | $2,000 |
| Established | up to $50 million | 251–1,000 | $6,000 |
| Large | up to $250 million | 1,001–5,000 | $15,000 |
| Very large | up to $1 billion | 5,001–10,000 | $30,000 |
| Global | above $1 billion | above 10,000 | $60,000 |

- **Funding counts in R.** R is gross revenue plus the equity, convertible notes, SAFEs and commercial grants received in the
  last 12 completed months; ordinary bank loans do not count. Ten people with no revenue and $20 million raised have
  R = $20 million and pay $6,000.
- **H counts the whole workforce**, not Charness users: employees, working founders and officers, regular unpaid workers,
  and contractors currently engaged after more than 30 worked days in 12 months. AI agents are not people.
- **The group is every company under common control**, worldwide — not a department. One operator in a 300-person group
  pays for the group.
- Two optional discounts, together 32% off: 20% for showing a "Powered by Charness" mark, 15% for prepaying 2 or 3 years.
- Buying is by e-mail: charnesshub@gmail.com; see the [commercial terms 1.0.0](https://github.com/olosegres/charness/blob/v4.2.0/LICENSE-COMMERCIAL.md) and, for the
  current terms, [LICENSE](LICENSE). Full refund within 30 days.

More cases, and what counts in R and H, as written for 1.0.0: the [licensing FAQ](https://github.com/olosegres/charness/blob/v4.2.0/docs/licensing-faq.md).

## What you have to do

- **Personal use, or a group within the free limits:** nothing. No registration, no payment. If the group later crosses a
  limit at a month end, it has 90 days to buy a license, to get back under the limit, or to stop.
- **An organization already above the limits:** buy the annual license for the group (or evaluate for under 32 days)
  before you move to 4.0.
- **An organization that already runs MIT Charness:** your MIT releases are unchanged. Moving to a 4.x release gives your
  group **one 90-day transition**, counted from the first day you use a 4.x release; by its end the group qualifies for
  free use, buys the license, or stops using 4.x. The transition and the evaluation run together, not one after the other.

## Staying on 3.x

Nothing forces the move. **Charness never installs a major version by itself:** with automatic updates on, the bot
announces 4.0 in the General topic and waits for your tap, and a git checkout also waits because the range adds this
guide. To make sure, set `/update` in General to **Off**. To pin an npm install on the newest 3.x release, run
`npm install -g charness@3`.

## Updating to 4.0

Read this guide, then update the way you always do — `/update` in General, `npm install -g charness@latest`, or
`scripts/self-update.sh` in a checkout ([Updating](SETUP.md#updating)). The first CHANGELOG entry of 4.0 is the license
change.
