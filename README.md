# TK Online Shop — Telegram Mini App Storefront

A mobile-friendly shopping storefront for **TK Online Shop** (Phnom Penh, Cambodia).
Built with plain HTML, CSS, and vanilla JavaScript — no frontend frameworks, build steps, or local database required.

Product and catalog data are managed via **Google Sheets**, orders are logged through **Google Apps Script**, and notifications are delivered via **Telegram**.

---

## Project Structure

```
cheasamnang-tkonlineshop/
├── index.html               # Storefront HTML, styling, and client-side logic
├── google-apps-script.js    # Google Apps Script webhook backend & Telegram integration
├── vercel.json              # Vercel static deployment configuration
├── nginx.conf               # Local Nginx development configuration
├── Dockerfile               # Container build definition (nginx:alpine)
├── docker-compose.yml       # Local Docker Compose service configuration
└── README.md                # Project documentation and developer guide
```

---

## Local Development with Docker

A self-contained Docker environment is provided using a lightweight Nginx web server. The project files are mounted into the container so any changes made to `index.html` are reflected immediately upon refreshing your browser.

### Local URL
* **Storefront:** [http://localhost:8104](http://localhost:8104) (or `http://127.0.0.1:8104`)

### Commands

* **Start the container:**
  ```bash
  docker compose up -d --build
  ```

* **Check status and health:**
  ```bash
  docker compose ps
  ```

* **View access and error logs:**
  ```bash
  docker compose logs -f web
  ```

* **Stop the container:**
  ```bash
  docker compose stop
  ```

* **Stop and remove container & network:**
  ```bash
  docker compose down
  ```
