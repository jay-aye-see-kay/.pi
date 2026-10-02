# Directory

## Channels (all private)

#wol_devex `C02NUQ65U2C` (camp channel — Hotel + Agentic Eng) · #team_hotel `C0B97KTKH25` (my team) · #team_agentic_engineering `C0BAJEK3HH8` (sister team).

Others: `slack("search_channels", { query: "name", channel_types: "public_channel,private_channel", response_format: "concise" })` → `#name (C…) - private_channel …` (default is public only, so private channels need `channel_types`). Channels I'm in: `slack("list_user_channels", { name_prefix: "team_" })`. Must be a member to post (`not_in_channel`).

## People

**Team Hotel** — Jack (me) `U010S548P0F` · Shay `U09UM9ZC6NN` · Felicity `U0ADQP9DSNS` · Elliott `UFMU99PCG`.
**Both teams** — Eric `U01LM3LA4Q5` (camp director) · Jason `U6W5LHSKD` (delivery manager).
**Agentic Engineering** — Will Brennan `U02SKHF1H3M` · Ando Saunders `U03LZFFA66P` · Tom Ridge `U62BKKDKK` · James Telfer `UHKEFHVF1` · Ellie Foote `U0829QPS4BC`.

Anyone else: `slack("search_users", { query: "Name", response_format: "concise" })` → `Name - U… - email - title`. For `from:@username` searches the handle is usually the email local part (e.g. `shay.qian2`; check `read_user_profile`).
