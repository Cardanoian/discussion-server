module.exports = {
  apps: [
    {
      name: 'discussion-server',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env_file: '.env',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      max_restarts: 10, // 최대 재시작 횟수 제한
      min_uptime: '10s', // 최소 실행 시간
    },
  ],
};
