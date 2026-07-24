module.exports = {
  apps: [
    {
      name: "s-backend",
      script: "./dist/server.js",
      instances: 1, // hozircha 1 ta — kelajakda cluster kerak bo'lsa oshiriladi
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      watch: false,
      env_production: {
        NODE_ENV: "production",
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      max_memory_restart: "500M", // xotira sizib ketsa avtomatik restart
    },
  ],
};
