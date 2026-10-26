export type SecurityPolicy = 'prompt' | 'block' | 'allow' | 'modal';

export interface SecurityConfig {
  policy?: SecurityPolicy;
  qshPolicy?: SecurityPolicy;
  clPolicy?: SecurityPolicy;
  pasePolicy?: SecurityPolicy;
  deployPolicy?: SecurityPolicy;
  requireCliClient?: boolean;
  promptTimeoutSeconds?: number;
  customBlockedCommands?: string[];
  customPromptCommands?: string[];
  allowedCommands?: string[];
  enableActionInspection?: boolean;
  allowQsh?: boolean;
  promptAllClCommands?: boolean;
}

export interface GuardrailDecision {
  allowed: boolean;
  status: 'allowed' | 'blocked' | 'confirmation_required' | 'confirmed' | 'prompt_approved' | 'prompt_rejected' | 'prompt_timeout';
  isDestructive: boolean;
  reason?: string;
  matchedPattern?: string;
  message?: string;
}

export interface EvaluateOptions {
  confirmed?: boolean;
  overridePrompter?: CommandPrompter;
  isAction?: boolean;
}

export type CommandPrompter = (details: {
  command: string;
  environment: string;
  reason: string;
  matchedPattern?: string;
}) => Promise<boolean>;

/**
 * Built-in destructive patterns for IBM i CL commands.
 * Matches root command verb (with optional library prefix, e.g. QSYS/DLTLIB or DLTLIB).
 */
const CL_DESTRUCTIVE_COMMAND_PATTERNS = [
  // Deletion commands (DLT*)
  /^(?:[A-Z0-9_#$@]+\/)?(DLTLIB|DLTOBJ|DLTF|DLTMSGF|DLTPGM|DLTMOD|DLTSRVPGM|DLTUSRPRF|DLTDIR|DLTSPLF|DLTDLO|DLTJRN|DLTJRNRCV|DLTDTAARA|DLTDTAQ|DLTDEVPRT|DLTDEVD|DLTCKPRG|DLTNWSSTG|DLTUDFS|DLTOVR|DLTCMD)\b/i,
  // General DLT* prefix catch-all for any delete command (e.g. DLTWSCST, DLTJOBD, etc.)
  /^(?:[A-Z0-9_#$@]+\/)?(DLT[A-Z0-9_#$@]+)\b/i,
  
  // Clear commands (CLR*)
  /^(?:[A-Z0-9_#$@]+\/)?(CLRPFM|CLRLIB|CLROUTQ|CLRDKT|CLRTAP|CLRMSGQ)\b/i,
  /^(?:[A-Z0-9_#$@]+\/)?(CLR[A-Z0-9_#$@]+)\b/i,

  // Disruptive / System shutdown commands
  /^(?:[A-Z0-9_#$@]+\/)?(PWRDWNSYS|ENDSBS|ENDSYS|ENDJOB|ENDTCPSVR|ENDTCPINT|INZSYS|RCLSTG|STRMAINT)\b/i,

  // Destructive authority & user profile changes
  /^(?:[A-Z0-9_#$@]+\/)?(CHGUSRPRF|RVKOBJAUT)\b/i,

  // Restore operations that may overwrite objects
  /^(?:[A-Z0-9_#$@]+\/)?(RSTLIB|RSTOBJ|RST)\b/i,

  // SQL execution with destructive statements inside RUNSQL or RUNSQLSTM
  /^(?:[A-Z0-9_#$@]+\/)?(?:RUNSQL|RUNSQLSTM)\b.*(?:\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b)/i
];

/**
 * Built-in destructive patterns for PASE and QSH shell commands.
 */
const PASE_DESTRUCTIVE_COMMAND_PATTERNS = [
  // rm command with recursive or force flags
  /\brm\s+.*-(?:[a-zA-Z]*[rfR]|[a-zA-Z]*--recursive|[a-zA-Z]*--force)/i,
  /\brm\s+-[a-zA-Z]*[rfR]/i,
  /\brm\s+.*(?:\*|\/)/i,
  /\brmdir\b/i,
  /\bunlink\b/i,
  /\bshred\b/i,

  // Process termination & system control
  /\bkill\s+-(?:9|KILL|HUP)\b/i,
  /\b(?:killall|pkill)\b/i,
  /\b(?:reboot|shutdown|halt|poweroff|init\s+[06])\b/i,

  // Mass filesystem / permission alterations
  /\bchmod\s+.*-(?:[a-zA-Z]*[rR]|--recursive)\s+(?:000|777)\b/i,
  /\bchown\s+.*-(?:[a-zA-Z]*[rR]|--recursive)\b/i,

  // Low-level disk manipulation
  /\bdd\s+if=/i,
  /\b(?:mkfs|format|fdisk)\b/i,

  // Shell redirection that empties or wipes targets
  />\s*\/dev\/(?:null|zero|sda|hda|kmem|mem)\b/i
];

/**
 * Patterns matching direct or indirect invocations of QSH from CL or PASE.
 */
const QSH_INVOCATION_PATTERNS = [
  /^(?:[A-Z0-9_#$@]+\/)?(?:STRQSH|QSH)\b/i,
  /(?:^|[/\s])qsh(?:\s+|$)/i,
  /\/QOpenSys\/usr\/bin\/qsh/i
];

export class SecurityGuardrail {
  private configGetter: () => SecurityConfig;
  private prompter?: CommandPrompter;

  constructor(
    configGetter: () => SecurityConfig = () => ({}),
    prompter?: CommandPrompter
  ) {
    this.configGetter = configGetter;
    this.prompter = prompter;
  }

  public setPrompter(prompter: CommandPrompter): void {
    this.prompter = prompter;
  }

  public getConfig(): SecurityConfig {
    const raw = this.configGetter() || {};

    let qshPolicy: SecurityPolicy = 'block';
    if (raw.qshPolicy) {
      qshPolicy = raw.qshPolicy;
    } else if (raw.allowQsh !== undefined) {
      qshPolicy = raw.allowQsh ? 'allow' : 'block';
    }

    let clPolicy: SecurityPolicy = 'prompt';
    if (raw.clPolicy) {
      clPolicy = raw.clPolicy;
    } else if (raw.promptAllClCommands !== undefined) {
      clPolicy = raw.promptAllClCommands ? 'prompt' : 'allow';
    } else if (raw.policy === 'allow') {
      clPolicy = 'allow';
    }

    const pasePolicy: SecurityPolicy = raw.pasePolicy || 'block';
    const deployPolicy: SecurityPolicy = raw.deployPolicy || 'prompt';

    return {
      policy: raw.policy || 'prompt',
      qshPolicy,
      clPolicy,
      pasePolicy,
      deployPolicy,
      promptTimeoutSeconds: raw.promptTimeoutSeconds ?? 60,
      customBlockedCommands: raw.customBlockedCommands || [],
      customPromptCommands: raw.customPromptCommands || [],
      allowedCommands: raw.allowedCommands || [],
      enableActionInspection: raw.enableActionInspection ?? true,
      allowQsh: qshPolicy === 'allow',
      promptAllClCommands: clPolicy === 'prompt'
    };
  }

  private async promptInteractive(
    command: string,
    environment: string,
    reason: string,
    matchedPattern: string | undefined,
    isDestructive: boolean,
    overridePrompter?: CommandPrompter
  ): Promise<GuardrailDecision> {
    const activePrompter = overridePrompter || this.prompter;
    if (!activePrompter) {
      return {
        allowed: false,
        status: 'blocked',
        isDestructive,
        reason: `Confirmation required for command (${matchedPattern || environment}), but no interactive prompter is available`,
        matchedPattern
      };
    }

    const config = this.getConfig();
    const timeoutSeconds = config.promptTimeoutSeconds ?? 60;
    try {
      const promptPromise = activePrompter({
        command,
        environment,
        reason,
        matchedPattern
      });

      const timeoutPromise = new Promise<boolean>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Prompt timeout'));
        }, timeoutSeconds * 1000);
        if (typeof timer.unref === 'function') timer.unref();
      });

      const approved = await Promise.race([promptPromise, timeoutPromise]);
      if (approved) {
        return {
          allowed: true,
          status: 'prompt_approved',
          isDestructive,
          reason: 'Execution approved by user confirmation',
          matchedPattern
        };
      } else {
        return {
          allowed: false,
          status: 'prompt_rejected',
          isDestructive,
          reason: 'Command execution rejected by user',
          matchedPattern
        };
      }
    } catch (err: any) {
      if (err.message === 'Prompt timeout') {
        return {
          allowed: false,
          status: 'prompt_timeout',
          isDestructive,
          reason: `Timed out waiting for user confirmation after ${timeoutSeconds}s`,
          matchedPattern
        };
      }
      return {
        allowed: false,
        status: 'prompt_rejected',
        isDestructive,
        reason: `User confirmation failed: ${err.message}`,
        matchedPattern
      };
    }
  }

  /**
   * Evaluates a command against the security policies and handles blocking or interactive prompt.
   */
  public async evaluateCommand(
    command: string,
    environment: 'ile' | 'pase' | 'qsh' = 'ile',
    optsOrConfirmedOrPrompter?: boolean | EvaluateOptions | CommandPrompter
  ): Promise<GuardrailDecision> {
    const cleanCmd = (command || '').trim();
    if (!cleanCmd) {
      return { allowed: true, status: 'allowed', isDestructive: false };
    }

    let confirmed = false;
    let overridePrompter: CommandPrompter | undefined = undefined;
    let isAction = false;

    if (typeof optsOrConfirmedOrPrompter === 'boolean') {
      confirmed = optsOrConfirmedOrPrompter;
    } else if (typeof optsOrConfirmedOrPrompter === 'function') {
      overridePrompter = optsOrConfirmedOrPrompter;
    } else if (optsOrConfirmedOrPrompter && typeof optsOrConfirmedOrPrompter === 'object') {
      confirmed = Boolean(optsOrConfirmedOrPrompter.confirmed);
      overridePrompter = optsOrConfirmedOrPrompter.overridePrompter;
      isAction = Boolean(optsOrConfirmedOrPrompter.isAction);
    }

    const config = this.getConfig();

    // 1. Whitelist check: If command is explicitly allowed, bypass all checks
    if (this.isWhitelisted(cleanCmd, config.allowedCommands)) {
      return { allowed: true, status: 'allowed', isDestructive: false, reason: 'Command is in allowed whitelist' };
    }

    // 2. Custom Blocklist check: Always blocked regardless of policy
    const blockedMatch = this.matchesPatterns(cleanCmd, config.customBlockedCommands);
    if (blockedMatch) {
      return {
        allowed: false,
        status: 'blocked',
        isDestructive: true,
        reason: `Command matches custom blocked list: ${blockedMatch}`,
        matchedPattern: blockedMatch
      };
    }

    // 3. QSH Policy Check
    const isQshEnv = environment === 'qsh';
    const invokesQsh = QSH_INVOCATION_PATTERNS.some(pat => pat.test(cleanCmd));
    const isQsh = isQshEnv || invokesQsh;

    if (isQsh) {
      const qshPolicy = config.qshPolicy || 'block';
      if (qshPolicy === 'block') {
        return {
          allowed: false,
          status: 'blocked',
          isDestructive: false,
          reason: `QSH execution is strictly disabled by security configuration ('code-for-ibmi-bridge.security.qshPolicy' is 'block').`,
          matchedPattern: isQshEnv ? 'environment:qsh' : 'qsh_invocation',
          message: `Execution of QSH commands and environments is disabled by security configuration. Update 'code-for-ibmi-bridge.security.qshPolicy' to allow or prompt if required.`
        };
      } else if (qshPolicy === 'prompt') {
        if (!confirmed) {
          return {
            allowed: false,
            status: 'confirmation_required',
            isDestructive: false,
            reason: `QSH execution requires confirmation ('code-for-ibmi-bridge.security.qshPolicy' is 'prompt').`,
            matchedPattern: isQshEnv ? 'environment:qsh' : 'qsh_invocation',
            message: `Execution of QSH commands requires explicit confirmation. Please confirm with the user and re-run with 'confirm: true' (or CLI flag --confirm).`
          };
        }
      } else if (qshPolicy === 'modal') {
        if (!confirmed) {
          const modalDecision = await this.promptInteractive(
            cleanCmd,
            'qsh',
            `QSH command execution requires user approval`,
            isQshEnv ? 'environment:qsh' : 'qsh_invocation',
            false,
            overridePrompter
          );
          if (!modalDecision.allowed) {
            return modalDecision;
          }
        }
      }
    }

    // 3b. PASE Policy Check
    const isPaseEnv = environment === 'pase';
    if (isPaseEnv) {
      const pasePolicy = config.pasePolicy || 'block';
      if (pasePolicy === 'block') {
        return {
          allowed: false,
          status: 'blocked',
          isDestructive: false,
          reason: `PASE execution is strictly disabled by security configuration ('code-for-ibmi-bridge.security.pasePolicy' is 'block').`,
          matchedPattern: 'environment:pase',
          message: `Execution of PASE commands and environments is disabled by security configuration. Update 'code-for-ibmi-bridge.security.pasePolicy' to allow or prompt if required.`
        };
      } else if (pasePolicy === 'prompt') {
        if (!confirmed) {
          return {
            allowed: false,
            status: 'confirmation_required',
            isDestructive: false,
            reason: `PASE execution requires confirmation ('code-for-ibmi-bridge.security.pasePolicy' is 'prompt').`,
            matchedPattern: 'environment:pase',
            message: `Execution of PASE commands requires explicit confirmation. Please confirm with the user and re-run with 'confirm: true' (or CLI flag --confirm).`
          };
        }
      } else if (pasePolicy === 'modal') {
        if (!confirmed) {
          const modalDecision = await this.promptInteractive(
            cleanCmd,
            'pase',
            `IBM i PASE command execution requires user approval`,
            'environment:pase',
            false,
            overridePrompter
          );
          if (!modalDecision.allowed) {
            return modalDecision;
          }
        }
      }
    }

    // 4. Inspect for Destructive Command Patterns
    const customPromptMatch = this.matchesPatterns(cleanCmd, config.customPromptCommands);
    const builtInMatch = this.detectBuiltInDestructive(cleanCmd, environment);
    const matchedPattern = customPromptMatch || builtInMatch;
    const isDestructive = Boolean(matchedPattern);

    if (isDestructive) {
      const destructivePolicy = config.policy || 'prompt';

      if (destructivePolicy === 'allow') {
        return {
          allowed: true,
          status: 'allowed',
          isDestructive: true,
          reason: `Command is potentially destructive (${matchedPattern}), but policy is set to 'allow'`,
          matchedPattern
        };
      }

      if (destructivePolicy === 'block') {
        return {
          allowed: false,
          status: 'blocked',
          isDestructive: true,
          reason: `Destructive command automatically blocked by security policy (${matchedPattern})`,
          matchedPattern
        };
      }

      if (destructivePolicy === 'modal') {
        if (confirmed) {
          return {
            allowed: true,
            status: 'confirmed',
            isDestructive: true,
            reason: 'Execution authorized with confirmation flag',
            matchedPattern
          };
        }
        return await this.promptInteractive(
          cleanCmd,
          environment,
          `Potentially destructive command detected: ${matchedPattern}`,
          matchedPattern,
          true,
          overridePrompter
        );
      }

      // Default destructive policy: 'prompt'
      if (confirmed) {
        return {
          allowed: true,
          status: 'confirmed',
          isDestructive: true,
          reason: 'Execution authorized with agent/user confirmation',
          matchedPattern
        };
      }

      return {
        allowed: false,
        status: 'confirmation_required',
        isDestructive: true,
        reason: `Destructive command requires confirmation before execution (${matchedPattern})`,
        matchedPattern,
        message: "Destructive command detected. Please ask the user for explicit confirmation in your chat interface. Once confirmed, re-issue this request with 'confirm: true' (or CLI flag --confirm)."
      };
    }

    // 5. CL Policy Check for Direct CL Commands (predefined actions are exempted)
    const isDirectCl = environment === 'ile' && !isAction;
    if (isDirectCl) {
      const clPolicy = config.clPolicy || 'prompt';

      if (clPolicy === 'block') {
        return {
          allowed: false,
          status: 'blocked',
          isDestructive: false,
          reason: `Direct CL command execution is blocked by security policy ('code-for-ibmi-bridge.security.clPolicy' is 'block').`,
          matchedPattern: 'cl_command',
          message: `Direct CL command execution is blocked by security policy. Use predefined actions or configure 'code-for-ibmi-bridge.security.clPolicy' to 'prompt' or 'allow'.`
        };
      }

      if (clPolicy === 'modal') {
        if (confirmed) {
          return {
            allowed: true,
            status: 'confirmed',
            isDestructive: false,
            reason: 'Execution authorized with confirmation flag',
            matchedPattern: 'cl_command'
          };
        }
        return await this.promptInteractive(
          cleanCmd,
          'ile',
          `IBM i CL command execution requires user approval`,
          'cl_command',
          false,
          overridePrompter
        );
      }

      if (clPolicy === 'prompt') {
        if (!confirmed) {
          return {
            allowed: false,
            status: 'confirmation_required',
            isDestructive: false,
            reason: `CL command execution requires explicit confirmation ('code-for-ibmi-bridge.security.clPolicy' is 'prompt')`,
            matchedPattern: 'cl_command',
            message: "CL command execution requires explicit confirmation. Please confirm with the user and re-run with 'confirm: true' (or CLI flag --confirm)."
          };
        }
      }
    }

    return {
      allowed: true,
      status: confirmed ? 'confirmed' : 'allowed',
      isDestructive: false
    };
  }


  private isWhitelisted(command: string, whitelist?: string[]): boolean {
    if (!whitelist || whitelist.length === 0) return false;
    return Boolean(this.matchesPatterns(command, whitelist));
  }

  private matchesPatterns(command: string, patterns?: string[]): string | undefined {
    if (!patterns || patterns.length === 0) return undefined;
    const lowerCmd = command.toLowerCase();
    for (const pat of patterns) {
      if (!pat || typeof pat !== 'string') continue;
      const cleanPat = pat.trim();
      if (!cleanPat) continue;

      // Try exact or prefix match
      if (lowerCmd === cleanPat.toLowerCase() || lowerCmd.startsWith(cleanPat.toLowerCase() + ' ')) {
        return cleanPat;
      }

      // Try regex match
      try {
        const regex = new RegExp(cleanPat, 'i');
        if (regex.test(command)) {
          return cleanPat;
        }
      } catch {
        // If pattern is not valid regex, fallback to substring
        if (lowerCmd.includes(cleanPat.toLowerCase())) {
          return cleanPat;
        }
      }
    }
    return undefined;
  }

  private detectBuiltInDestructive(command: string, environment: 'ile' | 'pase' | 'qsh'): string | undefined {
    if (environment === 'ile') {
      for (const regex of CL_DESTRUCTIVE_COMMAND_PATTERNS) {
        const match = command.match(regex);
        if (match) {
          return match[1] || match[0];
        }
      }
    } else {
      // PASE or QSH
      for (const regex of PASE_DESTRUCTIVE_COMMAND_PATTERNS) {
        const match = command.match(regex);
        if (match) {
          return match[0].trim();
        }
      }
    }
    return undefined;
  }

  /**
   * Evaluates a deployment request against security policies.
   * Priority is given to targeted file selection ('select method').
   * Blanket or unselected deployments require confirmation or modal approval.
   */
  public async evaluateDeploy(options: {
    selectedFiles?: string[];
    method?: string;
    confirmed?: boolean;
    pendingChanges?: string[];
    overridePrompter?: CommandPrompter;
  }): Promise<GuardrailDecision & { pendingChanges?: string[] }> {
    const config = this.getConfig();
    const deployPolicy = config.deployPolicy || 'prompt';
    const hasSelectedFiles = Array.isArray(options.selectedFiles) && options.selectedFiles.length > 0;
    const confirmed = Boolean(options.confirmed);
    const pendingChanges = options.pendingChanges || [];

    // Priority 1: If caller used the select method (explicit target files specified)
    if (hasSelectedFiles) {
      if (deployPolicy === 'modal' && !confirmed) {
        const fileList = options.selectedFiles!.join(', ');
        const decision = await this.promptInteractive(
          `Deploy selected files: ${fileList}`,
          'deploy',
          `Deployment of selected files requires user approval: ${fileList}`,
          'deploy_selected',
          false,
          options.overridePrompter
        );
        return { ...decision, pendingChanges };
      }
      return {
        allowed: true,
        status: confirmed ? 'confirmed' : 'allowed',
        isDestructive: false,
        reason: 'Selected files deployment approved (select method priority)',
        pendingChanges
      };
    }

    // Blanket / unselected deployment (method: changes, all, etc.)
    if (deployPolicy === 'allow') {
      return {
        allowed: true,
        status: 'allowed',
        isDestructive: false,
        reason: "Deployment policy is set to 'allow'",
        pendingChanges
      };
    }

    if (deployPolicy === 'block') {
      return {
        allowed: false,
        status: 'blocked',
        isDestructive: false,
        reason: `Blanket deployment without explicit target file selection is blocked ('code-for-ibmi-bridge.security.deployPolicy' is 'block').`,
        matchedPattern: 'deploy_unselected',
        pendingChanges,
        message: `Deployment without file selection is prohibited by security policy. Use the select method ('selectedFiles' / -Files) to deploy specific files.`
      };
    }

    if (deployPolicy === 'modal') {
      if (confirmed) {
        return {
          allowed: true,
          status: 'confirmed',
          isDestructive: false,
          pendingChanges
        };
      }
      const summary = pendingChanges.length > 0
        ? `Deploying ${pendingChanges.length} modified file(s):\n${pendingChanges.slice(0, 5).join('\n')}${pendingChanges.length > 5 ? '\n...' : ''}`
        : `Deploying workspace changes via method '${options.method || 'changes'}'`;
      const decision = await this.promptInteractive(
        summary,
        'deploy',
        `Workspace deployment requires user approval`,
        'deploy_unselected',
        false,
        options.overridePrompter
      );
      return { ...decision, pendingChanges };
    }

    // deployPolicy === 'prompt' (Default)
    if (confirmed) {
      return {
        allowed: true,
        status: 'confirmed',
        isDestructive: false,
        reason: 'Deployment authorized with user confirmation',
        pendingChanges
      };
    }

    return {
      allowed: false,
      status: 'confirmation_required',
      isDestructive: false,
      reason: `Deployment requires confirmation or specific file selection ('code-for-ibmi-bridge.security.deployPolicy' is 'prompt').`,
      matchedPattern: 'deploy_unselected',
      pendingChanges,
      message: `Deployment requires confirmation. Please either specify target file(s) to deploy using the select method ('selectedFiles' / -Files) as the top priority, or present the list of all pending changes to the user and re-run with 'confirm: true' (or CLI flag --confirm).`
    };
  }
}
