module.exports = {
    apps: [
        {
            name: "catatin-api",
            script: "src/index.ts",
            interpreter: "npx",
            interpreterArgs: "tsx",
            instances: "max", // auto: jumlah CPU cores
            exec_mode: "cluster",
            env: {
                NODE_ENV: "development",
            },
            env_production: {
                NODE_ENV: "production",
            },
            max_memory_restart: "500M",
            error_file: "logs/error.log",
            out_file: "logs/out.log",
            merge_logs: true,
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            watch: false,
            max_restarts: 10,
            restart_delay: 4000,
        },
    ],
};
