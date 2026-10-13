# Lead Ledger (Atomic Pillar realtor outreach)

Tracks prospects for the Atomic Pillar realtor SaaS ($59/mo, 14-day trial) from "found" to "paid", with cost and revenue. It drafts messages for a human to copy and send; it never sends anything.

## Workflow

1. **Find** realtors from public brokerage/team pages. Record where you found them (`source`) and the CASL basis (`consent_basis`).
2. **Add** them (`leads add` or `leads import file.csv`). Duplicates by email or phone are ignored, so a `do_not_contact` lead is never re-added.
3. **Review** the top of `leads list --min-score 50`. The score is a proxy built only from signals you recorded; unknown signals score zero.
4. **Draft** with `leads draft <id> --channel email|sms`, copy it, send it yourself, then run `leads sent <id> --channel ...`.
5. **Update** with `leads mark <id> replied|trial|paid|lost|do_not_contact`. Honour opt-outs immediately with `do_not_contact`.
6. **Measure** with `leads report --cost-to-serve <dollars>`. Rates are not meaningful until about 100 leads are contacted.

## Commands

```
automaton-cli leads add --name N [--email E] [--phone P] --source S --consent BASIS [--brokerage B] [--city C] [--soloOrSmallTeam ...]
automaton-cli leads import <file.csv>
automaton-cli leads list [--status S] [--min-score N] [--limit N]
automaton-cli leads draft <id> --channel email|sms
automaton-cli leads sent <id> --channel email|sms|call|other
automaton-cli leads mark <id> <status> [--note TEXT]
automaton-cli leads cost <id> <dollars> [--note TEXT]
automaton-cli leads report [--cost-to-serve DOLLARS]
```

CSV columns: `name,email,phone,brokerage,city,website,source,consent_basis,notes` plus any signal column (`soloOrSmallTeam, mobileContact, noChatOrBooking, recentActivity, slowReplyMentions, hasIsaOrCallCentre, inTargetArea`) with `yes`/`no`.

## Sender profile

Drafts need `~/.automaton/leads-sender.json`:

```json
{
  "senderName": "Your Name",
  "businessName": "Atomic Pillar",
  "mailingAddress": "Street, City, Province, Postal Code",
  "contactPhone": "+1 ...",
  "contactEmail": "you@example.com"
}
```

## Compliance notes

Canada's anti-spam law (CASL) covers email and SMS. Drafts include sender identity, a mailing address (email) and an opt-out, and make no performance claims. The ledger records the consent basis for every lead. This is not legal advice; have a lawyer confirm your practice before scaling.
