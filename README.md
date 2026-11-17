# Demoscene game shelf

A dark, Amiga-demoscene style page that shows a grid of games. Web games open in a new tab; installable games download their package. Sign in on the same page to add, edit, and delete games.

## Run it

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite` module). There is nothing to `npm install`.

```powershell
npm start
```

The process speaks plain HTTP. It listens on `127.0.0.1:8080` so only something on this machine, normally HAProxy, can reach it. Node prints an `ExperimentalWarning` for SQLite at startup; that is expected.

`PORT` changes the port. `HOST` changes the bind address (`0.0.0.0` if HAProxy runs on another machine).

## HAProxy

HAProxy terminates HTTPS and forwards to this process. Two things have to stay intact:

- The original `Host` header. The shelf compares it with the browser's `Origin` and rejects writes that do not match.
- `X-Forwarded-Proto: https`. The login cookie is marked `Secure` only when that header says the browser used HTTPS.

```
backend shelf
    http-request set-header X-Forwarded-Proto https
    server shelf 127.0.0.1:8080
```

Open the shelf at the HTTPS address HAProxy publishes, not at the raw HTTP port. The password cookie will not be stored by a browser that loaded the page over plain HTTP.

## Signing in

The first start creates `data/shelf.db` with one admin account and two sample games. The default login is:

- username: `admin`
- password: `change-me`

To choose your own, set these before the first start:

```powershell
$env:ADMIN_USERNAME = 'steve'
$env:ADMIN_PASSWORD = 'something long'
npm start
```

The password is stored as a scrypt hash. The variables are only read when no admin account exists yet. To reset the login later, stop the server, delete `data/shelf.db` (this also removes every game entry), and start again with the variables set.

Sessions are kept in memory and last 12 hours. Restarting the server signs everyone out.

## Managing games

Signed in, the shelf turns into an editor:

- **+ Add new** (top left) opens a blank editor.
- Clicking a card opens that game's editor instead of launching it. The editor's **Open** or **Download** button still reaches the game.
- **Log out** is at the top right.

Each game has a name, description, comma-separated tags, and a type:

- **Web game** needs a link (`https://...` or a path on this server starting with `/`).
- **Download** serves a package file as an attachment.

Thumbnails and packages can be uploaded from the editor, or copied into the folders below by hand and referenced by file name in the editor. Thumbnails can be png, jpg, jpeg, webp, gif, or svg; about 16:10 looks best. Uploads are limited to 10 MB for thumbnails and 4 GB for packages.

Deleting a game also deletes its thumbnail and package files when no other game uses them.

## Files

| Path | Holds |
| --- | --- |
| `server.js` | HTTP server, SQLite catalog, sign-in |
| `data/shelf.db` | Games, shelf title, admin account (gitignored) |
| `public/thumbnails/` | Thumbnail images |
| `public/packages/` | Downloadable packages |
| `public/` | The page itself |

The pixel font is [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) by CodeMan38, under the SIL Open Font License (`public/fonts/OFL.txt`).
