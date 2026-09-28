const password = process.env.AZUREKILN_RCLONE_CONFIG_PASSWORD;
if (!password) process.exitCode = 1;
else process.stdout.write(`${password}\n`);
