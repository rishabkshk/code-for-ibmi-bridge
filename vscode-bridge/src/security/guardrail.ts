export type SecurityPolicy = 'prompt' | 'block' | 'allow' | 'modal';

export interface SecurityConfig {
  policy?: SecurityPolicy;
  promptTimeoutSeconds?: number;
  customBlockedCommands?: string[];
  customPromptCommands?: string[];
  allowedCommands?: string[];
  enableActionInspection?: boolean;
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
    return {
      policy: raw.policy || 'prompt',
      promptTimeoutSeconds: raw.promptTimeoutSeconds ?? 60,
      customBlockedCommands: raw.customBlockedCommands || [],
      customPromptCommands: raw.customPromptCommands || [],
      allowedCommands: raw.allowedCommands || [],
      enableActionInspection: raw.enableActionInspection ?? true
    };
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

    if (typeof optsOrConfirmedOrPrompter === 'boolean') {
      confirmed = optsOrConfirmedOrPrompter;
    } else if (typeof optsOrConfirmedOrPrompter === 'function') {
      overridePrompter = optsOrConfirmedOrPrompter;
    } else if (optsOrConfirmedOrPrompter && typeof optsOrConfirmedOrPrompter === 'object') {
      confirmed = Boolean(optsOrConfirmedOrPrompter.confirmed);
      overridePrompter = optsOrConfirmedOrPrompter.overridePrompter;
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

    // 3. Custom Prompt check
    const customPromptMatch = this.matchesPatterns(cleanCmd, config.customPromptCommands);

    // 4. Built-in Destructive check
    const builtInMatch = this.detectBuiltInDestructive(cleanCmd, environment);
    const matchedPattern = customPromptMatch || builtInMatch;
    const isDestructive = Boolean(matchedPattern);

    if (!isDestructive) {
      return { allowed: true, status: 'allowed', isDestructive: false };
    }

    // If destructive, enforce policy
    const policy = config.policy || 'prompt';

    // Policy: ALLOW (Permissive)
    if (policy === 'allow') {
      return {
        allowed: true,
        status: 'allowed',
        isDestructive: true,
        reason: `Command is potentially destructive (${matchedPattern}), but policy is set to 'allow'`,
        matchedPattern
      };
    }

    // Policy: BLOCK (Strict)
    if (policy === 'block') {
      return {
        allowed: false,
        status: 'blocked',
        isDestructive: true,
        reason: `Destructive command automatically blocked by security policy (${matchedPattern})`,
        matchedPattern
      };
    }

    // Policy: MODAL (Legacy VS Code popup dialog)
    if (policy === 'modal') {
      if (confirmed) {
        return {
          allowed: true,
          status: 'confirmed',
          isDestructive: true,
          reason: 'Execution authorized with confirmation flag',
          matchedPattern
        };
      }

      const activePrompter = overridePrompter || this.prompter;
      if (!activePrompter) {
        return {
          allowed: false,
          status: 'blocked',
          isDestructive: true,
          reason: `Modal confirmation required for destructive command (${matchedPattern}), but no prompter is available`,
          matchedPattern
        };
      }

      const timeoutSeconds = config.promptTimeoutSeconds ?? 60;
      try {
        const promptPromise = activePrompter({
          command: cleanCmd,
          environment,
          reason: `Potentially destructive command detected: ${matchedPattern}`,
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
            isDestructive: true,
            reason: 'Execution approved by user confirmation',
            matchedPattern
          };
        } else {
          return {
            allowed: false,
            status: 'prompt_rejected',
            isDestructive: true,
            reason: 'Command execution rejected by user',
            matchedPattern
          };
        }
      } catch (err: any) {
        if (err.message === 'Prompt timeout') {
          return {
            allowed: false,
            status: 'prompt_timeout',
            isDestructive: true,
            reason: `Timed out waiting for user confirmation after ${timeoutSeconds}s`,
            matchedPattern
          };
        }
        return {
          allowed: false,
          status: 'prompt_rejected',
          isDestructive: true,
          reason: `User confirmation failed: ${err.message}`,
          matchedPattern
        };
      }
    }

    // Policy: PROMPT (Default - Alt 1: Two-step Agent Confirmation)
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
}
