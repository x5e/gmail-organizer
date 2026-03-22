# Gmail Organizer MCP — Hosting Options & Cost Analysis

## What This Server Actually Does

Before getting into costs and setup, it helps to understand what kind of server this actually is — because it shapes every decision below.

Each time Claude uses the connector, the flow is:

> **Claude → POST to your server → your server fetches the user's OAuth token, calls Gmail API → response back to Claude**

Your server is a **thin authenticated proxy**. It doesn't do heavy computation. It doesn't store emails. It doesn't serve images or videos. It receives a small JSON request, looks up a token in a database, makes one or a few Gmail API calls, and returns a small JSON response. The "heavy" work — Claude's AI reasoning about the user's inbox — happens entirely on Anthropic's infrastructure, not yours.

This means your hosting costs will be surprisingly low even at meaningful scale.

---

## Estimating the User Base

Claude's paying user base is in the millions. Being listed in Anthropic's connector directory gives you one-click discoverability to that entire base.

The realistic funnel for this connector:

- Gmail users who use Claude for productivity-type tasks: ~25–30% of Claude's users
- Of those, people who actively want AI help *organizing* email (vs. just reading or drafting): ~50%
- Of those, people who take the time to find and connect a new connector: ~15–20%

That math puts the realistic "successful connector" target somewhere in the **50,000–150,000 connected users** range for a well-known, well-reviewed listing. A breakout success could reach 300,000+.

Three scenarios used throughout this document:

| Scenario | Active Users |
|---|---|
| Modest success | 25,000 |
| Good success | 75,000 |
| Breakout | 250,000 |

---

## Request Volume

A typical usage session: a user asks Claude to help triage their inbox. Claude might call `list_labels` once, `search_messages` 2–4 times, `get_thread` on several results, then `batch_modify_message_labels` to apply labels. A realistic session is **10–20 MCP requests**. Users might do 2–3 sessions per week; casual users once a week or less. Averaged across everyone, **~80 MCP requests per active user per month** is a reasonable estimate.

| Scenario | Users | Requests/month | Avg req/sec | Peak req/sec (est. ~5×) |
|---|---|---|---|---|
| Modest | 25,000 | 2,000,000 | ~0.8 | ~4 |
| Good | 75,000 | 6,000,000 | ~2.3 | ~10 |
| Breakout | 250,000 | 20,000,000 | ~7.7 | ~35 |

**35 requests/second at peak is genuinely light traffic** for a modern HTTP server. By comparison, a modest e-commerce site handles multiples of this. This is not a high-traffic system.

The Gmail API itself is free regardless of call volume, as long as you stay within per-user rate limits (250 quota units/second/user), which your usage will easily do.

---

## Data Transfer

Most requests are metadata-heavy, not content-heavy. Searches and label modifications return small JSON payloads. The largest responses come from `get_message` and `get_thread` (full email bodies, 20–100 KB). Organization-focused workflows — the whole point of this connector — tend toward the cheaper end.

Rough average: **~25 KB outbound to Claude per MCP request**, ~3 KB inbound.

| Scenario | Egress/month | Ingress/month |
|---|---|---|
| Modest | ~50 GB | ~6 GB |
| Good | ~150 GB | ~18 GB |
| Breakout | ~500 GB | ~60 GB |

---

## Storage

Each connected user needs their refresh token stored — roughly 200–400 bytes encrypted. At 250,000 users, that's under 100 MB. Storage is essentially a rounding error in cost calculations.

---

## Hosting Options

There are five realistic approaches, ranging from "turn it on and forget it" to "cheapest possible at the cost of more hands-on work." The right choice depends more on your comfort with infrastructure than on cost — the differences in monthly spend are small relative to your time.

---

### Option A: Modern PaaS — Railway, Render, or Fly.io

**The idea:** These are hosting platforms designed to make deployment as easy as possible. You connect your GitHub repository, and the platform handles building your app, running it, restarting it if it crashes, managing TLS certificates, and scaling it up if traffic increases. You pick a database from a menu. The whole setup takes an afternoon.

**Monthly cost estimate:**

| Scenario | App server | Database | Total |
|---|---|---|---|
| Modest (25k users) | $10–20 | $15–20 | $25–40 |
| Good (75k users) | $20–40 | $15–25 | $35–65 |
| Breakout (250k users) | $60–100 | $20–40 | $80–140 |

**Pros:**
- Fastest to get running — no infrastructure expertise required
- Automatic TLS certificates (HTTPS "just works")
- Deploys automatically when you push code to GitHub
- Platform handles restarting, monitoring, and basic scaling
- Easy to add a second instance for redundancy with a checkbox

**Cons:**
- Slightly more expensive per unit of compute than running your own servers
- Less fine-grained control over networking and security configuration
- Vendor lock-in to the platform's tooling and pricing

**Recommended for:** Solo developers or small teams who want to move fast without hiring a DevOps person.

#### Setting It Up (Railway example)

1. **Create a Railway account** at railway.app and connect it to your GitHub account. Railway is free to sign up; you pay only for what you use.

2. **Create a new project.** Click "New Project" → "Deploy from GitHub repo" → select your MCP server repository. Railway will detect what kind of app it is (Node.js, Python, etc.) and configure the build automatically.

3. **Add a PostgreSQL database.** Inside your project, click "New" → "Database" → "PostgreSQL." Railway provisions a database and automatically injects a `DATABASE_URL` environment variable into your app. This is where the user OAuth tokens will be stored.

4. **Set your environment variables.** In the Railway dashboard, go to your app service → "Variables." Add:
   - `GOOGLE_CLIENT_ID` — from your Google Cloud Console OAuth app
   - `GOOGLE_CLIENT_SECRET` — from your Google Cloud Console OAuth app
   - `TOKEN_ENCRYPTION_KEY` — a long random string you generate (used to encrypt tokens at rest in the database)
   - `BASE_URL` — the public URL Railway assigns your app (looks like `https://your-app.up.railway.app`)

5. **Get your deployment URL.** Railway gives you a public URL automatically (e.g., `https://gmail-organizer.up.railway.app`). You can also point a custom domain here for free.

6. **Register the redirect URI in Google Cloud Console.** Go to APIs & Services → Credentials → your OAuth client → add `https://your-app.up.railway.app/oauth/callback` to the list of authorized redirect URIs. This is the URL Google will send the user back to after they approve access.

7. **Deploy.** Push a commit to your GitHub repo. Railway builds and deploys it automatically. Your server is live.

8. **Test it.** Visit `https://your-app.up.railway.app/health` (or whatever health-check endpoint you've implemented) and confirm the server responds. Then try connecting the MCP in Claude.

---

### Option B: Google Cloud Run + Cloud SQL

**The idea:** Cloud Run is Google's "serverless containers" platform. You package your app in a Docker container (a standardized way of shipping code with all its dependencies), push it to Google, and Cloud Run runs it on demand. You only pay when requests are actually being handled — when traffic drops to zero at 3am, so does your compute bill. Cloud SQL is Google's managed PostgreSQL service.

This option is worth noting specifically because your service calls Google's Gmail API. Keeping your server on Google's own infrastructure means the network path from your server to the Gmail API is very short and fast.

**Monthly cost estimate:**

| Scenario | Cloud Run compute | Cloud SQL | Network egress | Total |
|---|---|---|---|---|
| Modest (25k users) | $4–6 | $25 | $6 | $35–37 |
| Good (75k users) | $8–12 | $25 | $18 | $50–55 |
| Breakout (250k users) | $20–30 | $30–40 | $60 | $110–130 |

*(Add ~$15/month if you keep a minimum of 1 instance always running to avoid cold starts.)*

**Pros:**
- Pay only for actual request processing — genuinely $0 compute cost when idle
- Same network as Gmail API (low latency, no cross-cloud egress charges)
- Scales automatically from 0 to thousands of requests/second
- Google manages TLS, load balancing, and infrastructure

**Cons:**
- "Cold starts": if your server hasn't received a request in a while, the first request after the gap takes 1–3 extra seconds while the container boots up. This can create an awkward pause during OAuth authorization flows.
- GCP's console and billing interface is less intuitive than Railway or AWS
- Requires learning Docker to package your app

#### Setting It Up

1. **Create a Google Cloud account** at console.cloud.google.com. Set up billing (required even if you stay within free tier). Create a new Project for this service.

2. **Enable the necessary APIs.** In the GCP console, navigate to "APIs & Services" → "Enable APIs" and enable: Cloud Run API, Cloud SQL Admin API, Container Registry API (or Artifact Registry), Secret Manager API.

3. **Write a Dockerfile** for your MCP server. This is a text file in your repository root that describes how to build your app into a container. For a typical Node.js app it looks roughly like:
   ```
   FROM node:20-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --production
   COPY . .
   EXPOSE 8080
   CMD ["node", "server.js"]
   ```
   Python, Go, and other runtimes follow a similar pattern.

4. **Build and push the container to Google.** Install the `gcloud` command-line tool, then run:
   ```
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/gmail-mcp-server
   ```
   This uploads your code to Google, builds the container in the cloud, and stores it in Google Container Registry.

5. **Create a Cloud SQL instance.** In the GCP console, go to SQL → "Create Instance" → PostgreSQL. Choose the smallest size (db-f1-micro for testing, db-g1-small for production). Note the instance connection name (looks like `project:region:instance`).

6. **Store your secrets in Secret Manager.** Rather than putting credentials in environment variables directly, store them in GCP Secret Manager: your `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`. This is a more secure approach than plain environment variables.

7. **Deploy to Cloud Run.** In the GCP console, go to Cloud Run → "Create Service" → select your container image → configure:
   - Set minimum instances to 0 (for cost efficiency) or 1 (to avoid cold starts)
   - Set maximum instances to 10 (or more)
   - Connect to your Cloud SQL instance
   - Reference your Secret Manager secrets as environment variables
   - Set the port to 8080

8. **Get your service URL.** Cloud Run provides a URL like `https://gmail-mcp-server-xxxxxxxx-uc.a.run.app`. Add this to your Google OAuth app's authorized redirect URIs.

9. **Deploy updates** by rebuilding and pushing the container, then clicking "Deploy New Revision" in the Cloud Run console. Or set up Cloud Build to do this automatically on GitHub pushes.

---

### Option C: AWS ECS Fargate + RDS

**The idea:** AWS is the largest cloud provider and what most enterprises use. ECS (Elastic Container Service) with Fargate runs your Docker container without you managing the underlying servers. RDS is AWS's managed database service. This is the choice if you want maximum ecosystem maturity, the largest talent pool to hire from, or if you already have AWS infrastructure for other projects.

**Monthly cost estimate:**

| Scenario | Fargate compute | RDS PostgreSQL | Load balancer | Egress | Total |
|---|---|---|---|---|---|
| Modest (25k users) | $12 | $13 | $16 | $5 | $46 |
| Good (75k users) | $25 | $13 | $16 | $14 | $68 |
| Breakout (250k users) | $60–80 | $25 | $16 | $45 | $146–166 |

Note: The Application Load Balancer costs $16/month regardless of traffic — this is a meaningful fixed cost at low scale.

**Pros:**
- Extremely mature and well-documented platform
- Largest ecosystem of integrations, tooling, and monitoring options
- Strong security tooling (Secrets Manager, IAM, VPC, CloudTrail)
- Easiest to hire for if you bring on infrastructure help
- Automatic scaling, health checks, and rolling deploys built in

**Cons:**
- Most complex initial setup of any option here — VPCs, subnets, security groups, IAM roles, and task definitions all require configuration
- The $16/month load balancer is a noticeable fixed cost when you're small
- AWS's billing has many line items and can be confusing
- Overkill for a simple service like this unless you're already on AWS

#### Setting It Up

1. **Create an AWS account** at aws.amazon.com. Set up billing alerts immediately — AWS has many services and it's easy to accidentally leave something running. Set an alert for $50/month to start.

2. **Create an ECR repository.** ECR (Elastic Container Registry) is where your Docker images live. In the AWS console, go to ECR → "Create repository" → name it `gmail-mcp-server`.

3. **Write a Dockerfile** (same as Option B above) and push your container to ECR:
   ```
   aws ecr get-login-password | docker login --username AWS --password-stdin YOUR_ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
   docker build -t gmail-mcp-server .
   docker tag gmail-mcp-server:latest YOUR_ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/gmail-mcp-server:latest
   docker push YOUR_ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/gmail-mcp-server:latest
   ```

4. **Create a VPC and subnets** (or use the default VPC). Your RDS database and ECS tasks need to be in a VPC. Create security groups: one for the load balancer (allows inbound 443), one for the ECS tasks (allows inbound from the load balancer security group), one for RDS (allows inbound 5432 from the ECS security group only).

5. **Create an RDS PostgreSQL instance.** Go to RDS → "Create database" → PostgreSQL → choose db.t3.micro for modest traffic. Place it in the same VPC. Enable automated backups. Save the endpoint address, username, and password.

6. **Store secrets in AWS Secrets Manager.** Create secrets for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL`, and `TOKEN_ENCRYPTION_KEY`.

7. **Create an ECS cluster.** Go to ECS → "Create cluster" → choose "AWS Fargate" (serverless). Name it `gmail-mcp-cluster`.

8. **Create a Task Definition.** This is the blueprint for your container: how much CPU and memory (0.5 vCPU / 1 GB is sufficient), which container image to use, which secrets to inject as environment variables, which port to expose (e.g., 3000 or 8080).

9. **Create an Application Load Balancer.** Go to EC2 → Load Balancers → "Create" → Application. Configure a listener on port 443 (HTTPS — you'll need to request a certificate from AWS Certificate Manager, which is free). Create a target group pointing to your ECS service.

10. **Create an ECS Service.** Back in ECS, create a service from your task definition. Set desired task count to 2 (for redundancy). Connect it to your load balancer and target group. ECS will now run your containers and restart them if they crash.

11. **Get the load balancer DNS name** (looks like `gmail-mcp-12345.us-east-1.elb.amazonaws.com`). Point your custom domain's CNAME record to this. Add the final URL to your Google OAuth redirect URIs.

12. **Deploy updates** by pushing a new container image to ECR and then updating the ECS service to use the new image (it will do a rolling deploy with no downtime).

---

### Option D: AWS Lambda + API Gateway

**The idea:** Lambda is a "serverless functions" service — you write code that handles a single request, and AWS runs it on demand without you thinking about servers at all. You pay only for the milliseconds your code is actually executing. API Gateway sits in front and routes HTTP requests to your Lambda function.

**Monthly cost estimate:**

| Scenario | Lambda compute | API Gateway | DynamoDB | Egress | Total |
|---|---|---|---|---|---|
| Modest (25k users) | $4 | $2 | $1 | $5 | $12 |
| Good (75k users) | $8 | $6 | $1 | $14 | $29 |
| Breakout (250k users) | $18 | $20 | $2 | $45 | $85 |

**Pros:**
- Cheapest option at scale — you pay for nothing when no one is using it
- Zero operational overhead — no servers, no containers, no instances to monitor
- Scales automatically and instantly to any traffic level
- Works well with DynamoDB for token storage (no SQL database to manage)

**Cons:**
- **Cold starts**: Lambda functions that haven't been called recently take 200ms–2s to "wake up." This creates noticeable delays during OAuth authorization flows, which users may find frustrating
- **Statelessness**: Lambda has no persistent in-memory state, which makes the OAuth authorization code exchange (which requires a brief state handshake) more complex to implement correctly
- Local development and testing is more complex — you're developing for a specific runtime environment
- Maximum execution time is 15 minutes (not a concern here, but good to know)
- Adapting a conventional web framework to Lambda requires an adapter library (like Mangum for Python/FastAPI, or aws-lambda-web-adapter for Node.js)

**Recommended for:** Developers who are already comfortable with Lambda and want to minimize cost. Not recommended as a starting point if you're new to AWS.

#### Setting It Up

1. **Create an AWS account** and install the AWS CLI and the AWS SAM CLI (Serverless Application Model — a tool that simplifies Lambda deployments).

2. **Adapt your server code for Lambda.** If you're using Python with FastAPI, install `mangum` and wrap your app: `handler = Mangum(app)`. If you're using Node.js with Express, use `aws-lambda-web-adapter`. This makes your existing HTTP server work inside Lambda without rewriting it.

3. **Write a SAM template** (`template.yaml`) that defines your Lambda function, its memory and timeout settings, and the API Gateway that triggers it.

4. **Create a DynamoDB table** for token storage. Go to DynamoDB → "Create table" → name it `gmail-mcp-tokens` → partition key: `user_id` (string). DynamoDB is a key-value database; no schema setup required beyond the key.

5. **Store secrets in AWS Secrets Manager** (same as Option C).

6. **Deploy with SAM:**
   ```
   sam build
   sam deploy --guided
   ```
   SAM will package your code, upload it to S3, and deploy the Lambda function and API Gateway automatically.

7. **Get the API Gateway URL** (looks like `https://abc123.execute-api.us-east-1.amazonaws.com/prod`). Add this to your Google OAuth redirect URIs.

8. **Consider provisioned concurrency** to reduce cold starts. This keeps a set number of Lambda instances "warm" at all times. It costs more (roughly $15–20/month for 1 always-warm instance) but eliminates the cold start problem for OAuth flows.

---

### Option E: VPS — DigitalOcean, Hetzner, or Linode

**The idea:** A VPS (Virtual Private Server) is a virtual machine that you rent by the month. It's a Linux computer in a data center. You SSH in, install your app like you would on any Linux machine, and keep it running. This is the oldest and most manual approach — and also the cheapest.

**Monthly cost estimate:**

| Scenario | VPS (DigitalOcean) | VPS (Hetzner) | Managed PostgreSQL | Total (DO) | Total (Hetzner) |
|---|---|---|---|---|---|
| Modest (25k users) | $12 | €4 (~$5) | $15 | $27 | ~$20 |
| Good (75k users) | $24 | €8 (~$9) | $15 | $39 | ~$24 |
| Breakout (250k users) | $48 | €16 (~$18) | $20 | $68 | ~$38 |

Hetzner (a German/Finnish cloud provider) has remarkable price-to-performance ratios — their servers are typically 3–5x cheaper than DigitalOcean for equivalent specs. The tradeoff is that their data centers are in Europe and the US East Coast only.

**Pros:**
- Lowest absolute monthly cost by a wide margin
- Full control over everything — software, configuration, networking
- Not locked into any cloud provider's ecosystem or pricing
- Simple mental model: it's just a Linux computer

**Cons:**
- You are responsible for everything: TLS certificate renewal (automated with Let's Encrypt, but you set it up), keeping the OS updated, restarting the app if it crashes (use systemd or a process manager like PM2), deploying new versions, backups
- No automatic horizontal scaling — if you outgrow one server, you need to manually set up multiple servers and a load balancer
- More things that can go wrong and require your attention

**Recommended for:** Developers who are comfortable with Linux and want to minimize cost. This is a legitimate choice for production — many successful products run on VPS infrastructure indefinitely.

#### Setting It Up (DigitalOcean example)

1. **Create a DigitalOcean account** at digitalocean.com. Create a new Droplet: Ubuntu 22.04 LTS, the $24/month size (2 vCPU / 4 GB RAM, more than enough), in a data center region close to most of your users (US East if you're unsure).

2. **Set up SSH access.** When creating the Droplet, add your SSH public key. You'll use this to log in without a password. Once the Droplet is created, connect: `ssh root@YOUR_DROPLET_IP`.

3. **Create a non-root user** (security best practice):
   ```bash
   adduser deploy
   usermod -aG sudo deploy
   # Copy your SSH key to the new user
   rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
   ```

4. **Install your runtime.** For Node.js:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
   For Python: `sudo apt install -y python3 python3-pip`.

5. **Create a managed PostgreSQL database.** In DigitalOcean, go to Databases → "Create Database Cluster" → PostgreSQL. This is easier than installing PostgreSQL on the server yourself, and DigitalOcean handles backups. Note the connection string it gives you.

6. **Clone and configure your app.** Switch to the deploy user, clone your repository, install dependencies, and create a `.env` file with your environment variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `BASE_URL`).

7. **Set up a process manager** so your app restarts if it crashes. Using PM2 (Node.js) as an example:
   ```bash
   npm install -g pm2
   pm2 start server.js --name gmail-mcp
   pm2 save            # save the process list
   pm2 startup         # configure PM2 to start on system reboot
   ```

8. **Install nginx as a reverse proxy.** Nginx sits in front of your app, handles HTTPS, and forwards requests to your app:
   ```bash
   sudo apt install -y nginx
   ```
   Create `/etc/nginx/sites-available/gmail-mcp`:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       location / {
           proxy_pass http://localhost:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```
   Enable it: `sudo ln -s /etc/nginx/sites-available/gmail-mcp /etc/nginx/sites-enabled/`

9. **Get a free TLS certificate** using Let's Encrypt:
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```
   Certbot automatically configures nginx for HTTPS and sets up auto-renewal. Your site is now accessible at `https://your-domain.com`.

10. **Point your domain to the Droplet.** In your domain registrar's DNS settings, create an A record pointing `your-domain.com` (or a subdomain like `mcp.your-domain.com`) to the Droplet's IP address.

11. **Add the URL to your Google OAuth app** as an authorized redirect URI.

12. **Set up a deployment workflow.** The simplest approach: write a `deploy.sh` script on the server that does `git pull && npm install && pm2 restart gmail-mcp`. Run it over SSH from your laptop whenever you want to deploy a new version.

---

## Cost Comparison Summary

| Platform | 75k users/month | 250k users/month | Setup difficulty | Best for |
|---|---|---|---|---|
| PaaS (Railway/Render/Fly) | $35–65 | $80–140 | ★☆☆ Easy | Speed, simplicity, small teams |
| GCP Cloud Run + Cloud SQL | $50–55 | $110–130 | ★★☆ Moderate | Pay-per-use, same cloud as Gmail |
| AWS ECS Fargate + RDS | $68–75 | $150–165 | ★★★ Complex | Enterprise, AWS-native teams |
| AWS Lambda + API Gateway | $29–35 | $85–90 | ★★☆ Moderate | Cost optimization, Lambda expertise |
| VPS (DigitalOcean) | $39 | $68 | ★★☆ Moderate | Lowest cost, Linux-comfortable devs |
| VPS (Hetzner) | ~$24 | ~$38 | ★★☆ Moderate | Absolute lowest cost (Europe/US East) |

---

## Recommended Approach

**Start with a PaaS** (Railway, Render, or Fly.io). You can be live in an afternoon, deployment is automated, and you won't spend time on infrastructure problems while you're trying to validate the product. At 75,000 users you'll be spending $35–65/month — a genuinely trivial operating cost.

If the connector takes off and you want to optimize costs, migrating later is straightforward. The MCP server itself has no cloud-provider-specific dependencies; it's just an HTTP server talking to a PostgreSQL database. You can move it to any platform by changing environment variables and a deployment config.

**The costs that will matter far more than hosting** are the Google CASA security assessment ($500–$4,500/year), any premium monitoring or alerting tooling, and your own development and maintenance time. Even at 250,000 users, hosting is a minor line item — under $200/month on every platform listed here. The MCP's lightweight proxy architecture means hosting costs don't scale dramatically with users: most of the cost is fixed infrastructure (the database, a minimum set of instances), not per-request compute.
