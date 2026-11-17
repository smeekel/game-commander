# Demoscene game shelf

A dark, Amiga-demoscene style page that shows a grid of games. Web games open in a new tab; installable games download their package. Sign in on the same page to add, edit, and delete games.

## Run it

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite` module). There is nothing to `npm install`.

```powershell
npm start
```

Then open <https://localhost:8443>.

The server only speaks HTTPS. Node prints an `ExperimentalWarning` for SQLite at startup; that is expected.

Set `PORT` to use a different port. Binding 443 on Windows needs an elevated shell.

## Certificate

On first start, if the `certs` folder has no certificate, the server creates a self-signed one for `localhost` using Windows `New-SelfSignedCertificate`, saved as `certs/localhost.pfx` with its passphrase in `certs/localhost.pfx.pass`. Browsers warn about a self-signed certificate once; accept it to continue.

To use a real certificate, put `cert.pem` and `key.pem` in `certs/`. Those are used instead of the self-signed one. On macOS or Linux there is no automatic generation, so supply these two files, for example:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout certs/key.pem -out certs/cert.pem
```

`certs/` is gitignored.

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
| `server.js` | HTTPS server, SQLite catalog, sign-in |
| `data/shelf.db` | Games, shelf title, admin account (gitignored) |
| `public/thumbnails/` | Thumbnail images |
| `public/packages/` | Downloadable packages |
| `public/` | The page itself |
| `certs/` | TLS certificate (gitignored) |

The pixel font is [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) by CodeMan38, under the SIL Open Font License (`public/fonts/OFL.txt`).
